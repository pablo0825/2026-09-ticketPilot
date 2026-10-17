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
    // 收合票區保留的隱藏張數也算在內。
    if (
        dom.tickets.some(row => row.quantities.some(value => value !== "0")) ||
        dom.areas.some(area => area.hiddenQuantities.some(value => value !== "0"))
    ) {
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

    // 空窗：只缺庫存文字時等待（形狀規則與 domSnapshot 監測相同；名稱不變由監測比對）；計數器可保留但形狀須完整，
    // 張數非零已於上方停止，名稱缺失仍拒絕。
    const countersComplete = dom.tickets.every(
        row =>
            row.counterCount <= 1 &&
            row.quantities.length === row.counterCount &&
            row.plus.length === row.counterCount &&
            row.minus.length === row.counterCount,
    );

    // 票種列版型：每列只剩票名，沒有庫存、售完與暫無票券文字。
    const rowGap =
        dom.areas.length === 0 &&
        dom.tickets.length > 0 &&
        dom.tickets.every(
            row =>
                row.names.length === 1 &&
                row.names[0]?.trim() &&
                row.statuses.length === 0 &&
                row.soldOut === 0 &&
                row.unavailable === 0,
        );

    // 票區面板版型：每個票區標題只剩名稱，沒有庫存文字。
    const areaGap =
        dom.areas.length > 0 &&
        dom.areas.every(area => area.names.length === 1 && area.names[0]?.trim() && area.stock.length === 0);
    const gap = countersComplete && (rowGap || areaGap);
    return gap && dom.nextButtons.length === 1
        ? { status: "pending", reason: "refresh-data-loading" }
        : { status: "stop", reason: "unexpected-page" };
}
