import type { ElementHandle, Page } from "playwright";
import { readTicketPlusPageWithMarkers } from "./pageState.js";
import type { TicketPlusPage, TicketPlusPageMarkers } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type InformationSubmissionReason =
    | "not-purchase-page"
    | "contact-missing"
    | "terms-missing"
    | "terms-unchecked"
    | "next-unavailable"
    | "checkout-not-reached"
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

const termsPattern = /^我已經閱讀並同意\s*會員服務條款\s*與\s*隱私權政策$/;

function bounded(control: TicketPlusRunControl, milliseconds: number): number {
    return Math.max(1, Math.min(milliseconds, control.remainingMs()));
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

// 條款的可點控制項：Vuetify 隱藏 input 的外層，沒有外層時才用 input 本身；不點 label 文字（內含條款連結）。
// 函式內只用行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。
function locateTermsControl(pattern: string): Element | null {
    const matcher = new RegExp(pattern);
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(input =>
        Array.from((input as HTMLInputElement).labels ?? []).some(label =>
            matcher.test((label.textContent ?? "").replace(/\s+/g, " ").trim()),
        ),
    );
    if (inputs.length !== 1) return null;
    return inputs[0]!.closest(".v-input--selection-controls__input") ?? inputs[0]!;
}

// 勾選服務條款：已勾就不點；點一次後核對已勾選，未勾選也不再點第二次。
export async function checkTicketPlusTerms(
    page: Page,
    control: TicketPlusRunControl,
    isChecked: () => Promise<boolean>,
    clickTimeoutMs = 5_000,
): Promise<void> {
    if (await isChecked()) return;
    const handle = await control.read(() => page.evaluateHandle(locateTermsControl, termsPattern.source));
    const target = handle.asElement();
    if (!target) {
        await handle.dispose().catch(() => {});
        throw new InformationStop("terms-missing");
    }
    try {
        control.check();
        await target.click({ timeout: bounded(control, clickTimeoutMs) });
    } catch (error) {
        if (error instanceof TicketPlusStopError) throw error;
        throw new InformationStop("terms-unchecked");
    } finally {
        await target.dispose().catch(() => {});
    }
    if (!(await isChecked())) throw new InformationStop("terms-unchecked");
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

// 購票資料頁：確認聯絡欄位有值、勾條款、按一次下一步，停在付款頁「前往付款」之前；不付款、不重按。
export async function submitTicketPlusInformation(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: InformationSubmissionOptions = {},
): Promise<InformationSubmissionResult> {
    const clickTimeoutMs = options.clickTimeoutMs ?? 5_000;
    let clicked = false;
    let handle: ElementHandle | null = null;
    try {
        // 核對同場次購票資料頁與聯絡欄位（只看有無值，不比對內容）。
        control.check();
        const information = await readPurchaseInformation(page, session, control);
        const fields = Object.values(information.contactFields);
        if (!fields.every(field => field.present && field.hasValue))
            return { outcome: "stopped", reason: "contact-missing" };

        // 勾選條款後重新核對下一步已啟用。
        await checkTicketPlusTerms(
            page,
            control,
            async () => (await readPurchaseInformation(page, session, control)).termsChecked,
            clickTimeoutMs,
        );
        const ready = await readPurchaseInformation(page, session, control);
        if (!ready.termsChecked) return { outcome: "stopped", reason: "terms-unchecked" };
        if (!ready.nextEnabled) return { outcome: "stopped", reason: "next-unavailable" };

        // 固定唯一的「下一步」節點，點擊前再核對頁面，只按一次。
        const locator = page.locator("button.nextBtn").filter({ hasText: /^\s*下一步\s*$/, visible: true });
        if ((await control.read(() => locator.count())) !== 1)
            return { outcome: "stopped", reason: "next-unavailable" };
        handle = await control.read(() => locator.elementHandle({ timeout: bounded(control, clickTimeoutMs) }));
        const latest = await readPurchaseInformation(page, session, control);
        if (!latest.termsChecked || !latest.nextEnabled) return { outcome: "stopped", reason: "next-unavailable" };
        const timeout = bounded(control, clickTimeoutMs);
        clicked = true;
        await handle.click({ timeout });

        // 等待同場次付款頁；期限內沒到就回報未確認，不重按。
        const deadline = performance.now() + bounded(control, options.timeoutMs ?? 15_000);
        while (performance.now() < deadline) {
            const after = await control.read(() => readTicketPlusPageWithMarkers(page)).catch(() => undefined);
            if (isPaymentPage(after?.markers, session)) return { outcome: "payment-ready" };
            await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 100, deadline - performance.now())));
        }
        return { outcome: "unknown", reason: "checkout-not-reached" };
    } catch (error) {
        if (clicked) return { outcome: "unknown", reason: "checkout-not-reached" };
        if (error instanceof InformationStop) return { outcome: "stopped", reason: error.reason };
        if (error instanceof TicketPlusStopError) {
            return { outcome: "stopped", reason: error.stopReason === "time-limit" ? "time-limit" : "user-stopped" };
        }
        throw error;
    } finally {
        await handle?.dispose().catch(() => {});
    }
}
