import type { ElementHandle, Page } from "playwright";
import { checkTicketPlusTerms, InformationStop } from "./informationSubmission.js";
import { readTicketPlusLotteryInput } from "./lotteryInput.js";
import { readTicketPlusPageWithMarkers } from "./pageState.js";
import type { TicketPlusPageMarkers } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type LotteryStopReason =
    | "not-input-page"
    | "dialog-open"
    | "participant-count"
    | "participant-incomplete"
    | "terms-missing"
    | "terms-unchecked"
    | "next-unavailable"
    | "checkout-not-reached"
    | "read-failed"
    | "time-limit"
    | "user-stopped";
export type LotteryCompletionResult =
    { outcome: "registration-ready" } | { outcome: "stopped" | "unknown"; reason: LotteryStopReason };

export interface LotteryCompletionOptions {
    // 按下一步後等待確認登記頁的上限；仍受全程期限限制。
    timeoutMs?: number;
    clickTimeoutMs?: number;
    pollIntervalMs?: number;
}

class LotteryStop extends Error {
    constructor(readonly reason: LotteryStopReason) {
        super(reason);
    }
}

function bounded(control: TicketPlusRunControl, milliseconds: number): number {
    return Math.max(1, Math.min(milliseconds, control.remainingMs()));
}

// 核對同場次輸入資料頁：沒有開啟的彈窗、參加者列數等於張數且每列已填；回傳條款與下一步狀態。
async function readReadyInput(
    page: Page,
    session: VerifiedTicketPlusSession,
    quantity: number,
    control: TicketPlusRunControl,
): Promise<{ termsChecked: boolean; nextEnabled: boolean }> {
    const read = await control.read(() => readTicketPlusPageWithMarkers(page));
    if (read.markers && read.markers.dialogs > 0) throw new LotteryStop("dialog-open");
    const input = readTicketPlusLotteryInput(read, session);
    if (input.kind !== "input" || read.page.kind !== "information") throw new LotteryStop("not-input-page");
    if (input.applicants.length !== quantity) throw new LotteryStop("participant-count");
    if (!input.applicants.every(applicant => applicant.filled)) throw new LotteryStop("participant-incomplete");
    return { termsChecked: read.page.termsChecked, nextEnabled: read.page.nextEnabled };
}

// 抵達同場次確認登記頁：唯一「確認登記」、沒有「前往付款」、沒有彈窗或排隊。
function isRegisterPage(markers: TicketPlusPageMarkers | undefined, session: VerifiedTicketPlusSession): boolean {
    return (
        markers !== undefined &&
        markers.origin === "https://ticketplus.com.tw" &&
        markers.pathname.replace(/\/$/, "") === `/checkout/${session.eventId}/${session.sessionId}` &&
        markers.registerButtons.length === 1 &&
        markers.paymentButtons.length === 0 &&
        markers.dialogs === 0 &&
        markers.queue === 0
    );
}

// 按下一步後等待確認登記頁；期限內沒到就回報未確認，不重按。
async function waitForRegisterPage(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: LotteryCompletionOptions,
): Promise<LotteryCompletionResult> {
    const deadline = performance.now() + bounded(control, options.timeoutMs ?? 15_000);
    while (performance.now() < deadline) {
        const after = await control.read(() => readTicketPlusPageWithMarkers(page)).catch(() => undefined);
        if (isRegisterPage(after?.markers, session)) return { outcome: "registration-ready" };
        await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 100, deadline - performance.now())));
    }
    return { outcome: "unknown", reason: "checkout-not-reached" };
}

// 抽選收尾：使用者確認填完參加者後，核對頁面、勾條款、按一次下一步，停在「確認登記」之前；
// 不讀取參加者資料、不按確認登記或取消登記、不重按。
export async function completeTicketPlusLottery(
    page: Page,
    session: VerifiedTicketPlusSession,
    quantity: number,
    control: TicketPlusRunControl,
    options: LotteryCompletionOptions = {},
): Promise<LotteryCompletionResult> {
    const clickTimeoutMs = options.clickTimeoutMs ?? 5_000;
    let clicked = false;
    let handle: ElementHandle | null = null;
    try {
        // 核對輸入資料頁與參加者狀態。
        control.check();
        await readReadyInput(page, session, quantity, control);

        // 勾選條款後重新核對下一步已啟用。
        await checkTicketPlusTerms(
            page,
            control,
            async () => (await readReadyInput(page, session, quantity, control)).termsChecked,
            clickTimeoutMs,
        );
        const ready = await readReadyInput(page, session, quantity, control);
        if (!ready.termsChecked) return { outcome: "stopped", reason: "terms-unchecked" };
        if (!ready.nextEnabled) return { outcome: "stopped", reason: "next-unavailable" };

        // 固定唯一的「下一步」節點，點擊前再核對頁面，只按一次。
        const locator = page.getByRole("button", { name: "下一步", exact: true }).filter({ visible: true });
        if ((await control.read(() => locator.count())) !== 1) {
            return { outcome: "stopped", reason: "next-unavailable" };
        }
        handle = await control.read(() => locator.elementHandle({ timeout: bounded(control, clickTimeoutMs) }));
        const latest = await readReadyInput(page, session, quantity, control);
        if (!latest.termsChecked || !latest.nextEnabled) return { outcome: "stopped", reason: "next-unavailable" };
        const timeout = bounded(control, clickTimeoutMs);
        clicked = true;
        await handle.click({ timeout });

        // 抵達同場次確認登記頁才完成。
        return await waitForRegisterPage(page, session, control, options);
    } catch (error) {
        if (clicked) return { outcome: "unknown", reason: "checkout-not-reached" };
        if (error instanceof LotteryStop) return { outcome: "stopped", reason: error.reason };
        if (
            error instanceof InformationStop &&
            (error.reason === "terms-missing" || error.reason === "terms-unchecked")
        ) {
            return { outcome: "stopped", reason: error.reason };
        }
        if (error instanceof TicketPlusStopError) {
            return { outcome: "stopped", reason: error.stopReason === "time-limit" ? "time-limit" : "user-stopped" };
        }
        // 點擊前的其他錯誤仍是未送出，明確停止而非未確認。
        return { outcome: "stopped", reason: "read-failed" };
    } finally {
        await handle?.dispose().catch(() => {});
    }
}
