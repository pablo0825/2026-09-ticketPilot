import type { TicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusPage } from "./pageState.js";
import type { PageReadiness } from "./pageReadiness.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";
import { readEventDetails } from "./readResult.js";

// 更新留在原場次；過渡不改變一般選票頁的嚴格分類。
export function refreshReadiness(
    dom: TicketPlusDom | undefined,
    page: TicketPlusPage,
    target: VerifiedTicketPlusSession,
): PageReadiness {
    // 先排除讀取、身分及跨流程衝突，再決定是否繼續等待。
    if (!dom || (page.kind === "unknown" && ["read-failed", "page-changed"].includes(page.reason))) {
        return { status: "stop", reason: "read-failed" };
    }
    if (
        dom.origin !== "https://ticketplus.com.tw" ||
        dom.extraUrlParts ||
        dom.pathname.replace(/\/$/, "") !== `/order/${target.eventId}/${target.sessionId}`
    ) {
        return { status: "stop", reason: "identity-mismatch" };
    }
    const identity = readEventDetails(dom);
    if (
        !identity ||
        identity.eventName !== target.eventName ||
        identity.date !== target.date ||
        identity.time !== target.time
    ) {
        return { status: "stop", reason: "identity-mismatch" };
    }
    if (
        dom.dialogs.length ||
        dom.queueCount ||
        dom.activity.length ||
        dom.information.headingCount ||
        dom.information.terms.length ||
        dom.information.contact.some(fields => fields.length) ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount ||
        dom.checkout.length
    ) {
        return { status: "stop", reason: "unexpected-page" };
    }

    // 張數殘留及按鈕歧義不能以資料仍在載入掩蓋。
    if (dom.tickets.some(row => row.quantities.some(value => value !== "0"))) {
        return { status: "stop", reason: "remaining-quantity" };
    }
    if (dom.refreshEvidence?.invalid) return { status: "stop", reason: "unexpected-page" };
    if (dom.refreshButtons.length > 1) return { status: "stop", reason: "button-unavailable" };
    const evidence = dom.refreshEvidence;
    if (page.kind === "ticket-selection") {
        return evidence?.clicked && evidence.buttonAbsent && evidence.dynamicGap && dom.refreshButtons[0] === true
            ? { status: "ready", reason: "refresh-completed" }
            : { status: "pending", reason: "refresh-not-complete" };
    }

    // 僅缺少庫存與售完文字的票列等待；計數器可保留但形狀須完整（與 domSnapshot 監測相同），
    // 張數非零已於上方停止，票名缺失仍拒絕。
    const gap =
        dom.tickets.length > 0 &&
        dom.tickets.every(
            row =>
                row.names.length === 1 &&
                row.names[0]?.trim() &&
                row.statuses.length === 0 &&
                row.soldOut === 0 &&
                row.counterCount <= 1 &&
                row.quantities.length === row.counterCount &&
                row.plus.length === row.counterCount &&
                row.minus.length === row.counterCount,
        );
    return gap && dom.nextButtons.length === 1
        ? { status: "pending", reason: "refresh-data-loading" }
        : { status: "stop", reason: "unexpected-page" };
}
