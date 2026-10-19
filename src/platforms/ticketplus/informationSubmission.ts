import type { Page } from "playwright";
import { checkTicketPlusTerms, pressNextOnce, TermsStop, waitForMarkers } from "./confirmPageActions.js";
import { readTicketPlusPageWithMarkers } from "./pageState.js";
import type { TicketPlusPage, TicketPlusPageMarkers } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type InformationSubmissionReason =
    | "not-purchase-page"
    | "terms-missing"
    | "terms-unchecked"
    | "next-unavailable"
    | "checkout-not-reached"
    | "read-failed"
    | "time-limit"
    | "user-stopped";
export type InformationSubmissionResult =
    { outcome: "payment-ready" } | { outcome: "stopped" | "unknown"; reason: InformationSubmissionReason };

export interface InformationSubmissionOptions {
    // 按下一步後等待付款頁的上限；仍受全程期限限制。
    timeoutMs?: number;
    clickTimeoutMs?: number;
    pollIntervalMs?: number;
}

class InformationStop extends Error {
    constructor(readonly reason: InformationSubmissionReason) {
        super(reason);
    }
}

function sameSession(page: TicketPlusPage, session: VerifiedTicketPlusSession): boolean {
    return (
        "eventId" in page &&
        page.eventId === session.eventId &&
        "sessionId" in page &&
        page.sessionId === session.sessionId
    );
}

// 讀取並核對仍是同場次的購票資料頁；抽選輸入資料頁（有參加者資訊）不能用購票流程送出。
async function readPurchaseInformation(page: Page, session: VerifiedTicketPlusSession, control: TicketPlusRunControl) {
    const { page: value, markers } = await control.read(() => readTicketPlusPageWithMarkers(page));
    if (value.kind !== "information" || !sameSession(value, session) || !markers) {
        throw new InformationStop("not-purchase-page");
    }
    if (markers.participantSections > 0) throw new InformationStop("not-purchase-page");
    return value;
}

// 抵達同場次付款頁：唯一「前往付款」、沒有「確認登記」、沒有彈窗或排隊。
function isPaymentPage(markers: TicketPlusPageMarkers | undefined, session: VerifiedTicketPlusSession): boolean {
    return (
        markers !== undefined &&
        markers.origin === "https://ticketplus.com.tw" &&
        markers.pathname.replace(/\/$/, "") === `/checkout/${session.eventId}/${session.sessionId}` &&
        markers.paymentButtons.length === 1 &&
        markers.registerButtons.length === 0 &&
        markers.dialogs === 0 &&
        markers.queue === 0
    );
}

// 購票資料頁：核對同活動與場次、勾條款、按一次下一步，停在付款頁「前往付款」之前；不付款、不重按。
export async function submitTicketPlusInformation(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: InformationSubmissionOptions = {},
): Promise<InformationSubmissionResult> {
    const clickTimeoutMs = options.clickTimeoutMs ?? 5_000;
    let clicked = false;
    try {
        // 核對同活動、同場次的購票資料頁。
        control.check();
        await readPurchaseInformation(page, session, control);

        // 勾選條款後重新核對下一步已啟用。
        const isChecked = async () => (await readPurchaseInformation(page, session, control)).termsChecked;
        await checkTicketPlusTerms(page, control, isChecked, clickTimeoutMs);
        const ready = await readPurchaseInformation(page, session, control);
        if (!ready.termsChecked) return { outcome: "stopped", reason: "terms-unchecked" };
        if (!ready.nextEnabled) return { outcome: "stopped", reason: "next-unavailable" };

        // 點擊前再核對頁面，只按一次下一步。
        const recheck = async () => {
            const latest = await readPurchaseInformation(page, session, control);
            return latest.termsChecked && latest.nextEnabled;
        };
        const pressed = await pressNextOnce(page, control, recheck, clickTimeoutMs, () => {
            clicked = true;
        });
        if (pressed === "unavailable") return { outcome: "stopped", reason: "next-unavailable" };

        // 抵達同場次付款頁才完成。
        const arrived = await waitForMarkers(page, control, markers => isPaymentPage(markers, session), options);
        return arrived ? { outcome: "payment-ready" } : { outcome: "unknown", reason: "checkout-not-reached" };
    } catch (error) {
        if (clicked) return { outcome: "unknown", reason: "checkout-not-reached" };
        if (error instanceof InformationStop || error instanceof TermsStop) {
            return { outcome: "stopped", reason: error.reason };
        }
        if (error instanceof TicketPlusStopError) {
            return { outcome: "stopped", reason: error.stopReason === "time-limit" ? "time-limit" : "user-stopped" };
        }
        // 點擊前的其他錯誤（頁面重繪、讀取失敗）仍是未送出，明確停止而非未確認。
        return { outcome: "stopped", reason: "read-failed" };
    }
}
