import type { TicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusPage } from "./pageState.js";
import type { ActivityLoadingTarget } from "./activityLoading.js";

export type PageReadiness = { status: "ready" | "pending" | "stop"; reason: string };

export function activityReadiness(
    dom: TicketPlusDom | undefined,
    result: TicketPlusPage,
    target: ActivityLoadingTarget,
): PageReadiness {
    // 等待只讀同活動頁；跨流程內容與彈窗立即停止。
    if (!dom) return { status: "stop", reason: "read-failed" };
    const route = /^\/activity\/([A-Za-z0-9_-]+)\/?$/.exec(dom.pathname);
    if (dom.origin !== "https://ticketplus.com.tw" || dom.extraUrlParts || route?.[1] !== target.eventId) {
        return { status: "stop", reason: "route-mismatch" };
    }
    if (
        dom.dialogs.length ||
        dom.queueCount ||
        dom.tickets.length ||
        dom.information.headingCount ||
        dom.information.terms.length ||
        dom.information.contact.some(fields => fields.length > 0) ||
        dom.nextButtons.length ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount ||
        dom.checkout.length
    ) {
        return { status: "stop", reason: "conflicting-content" };
    }

    // 完整活動交回既有核對；未完成的同名內容只等待，不去重或授予點擊資格。
    if (result.kind === "activity") return { status: "ready", reason: "activity-parsed" };
    if (dom.activityNames.some(name => name.trim() && name !== target.eventName)) {
        return { status: "stop", reason: "event-name-mismatch" };
    }
    return { status: "pending", reason: "activity-not-ready" };
}
