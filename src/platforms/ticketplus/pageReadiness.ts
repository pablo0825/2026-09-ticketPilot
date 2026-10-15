import { parseActivityPage } from "./activityPage.js";
import { readEventDetails } from "./readResult.js";
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
export interface SelectionEntryTarget extends ActivityLoadingTarget {
    sessionName: string;
    date: string;
    time: string;
}

export function selectionReadiness(
    dom: TicketPlusDom | undefined,
    result: TicketPlusPage,
    target: SelectionEntryTarget,
): PageReadiness {
    // 暫時讀不到時只等待；外層仍檢查實際網址與期限。
    if (!dom) return { status: "pending", reason: "read-failed" };
    const route = /^\/(activity|order)\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?\/?$/.exec(dom.pathname);
    if (
        dom.origin !== "https://ticketplus.com.tw" ||
        dom.extraUrlParts ||
        route?.[2] !== target.eventId ||
        (route[1] === "activity" ? !!route[3] : !route[3])
    ) {
        return { status: "stop", reason: "route-mismatch" };
    }
    if (
        dom.dialogs.length ||
        dom.queueCount ||
        dom.information.headingCount ||
        dom.information.terms.length ||
        dom.information.contact.some(fields => fields.length > 0) ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount ||
        dom.checkout.length
    ) {
        return { status: "stop", reason: "conflicting-content" };
    }

    // 明確錯誤的活動或完整場次仍停止；重疊及殘缺不改寫成合法頁面。
    if (dom.activityNames.some(name => name.trim() && name !== target.eventName)) {
        return { status: "stop", reason: "event-name-mismatch" };
    }
    if (result.kind === "ticket-selection") return { status: "ready", reason: "selection-parsed" };
    const details = readEventDetails(dom);
    if (
        details &&
        (details.eventName !== target.eventName || details.date !== target.date || details.time !== target.time)
    ) {
        return { status: "stop", reason: "selection-identity-mismatch" };
    }
    const activity = parseActivityPage(dom, target.eventId);
    if (activity.kind === "activity") {
        const matches = activity.sessions.filter(
            session => session.date === target.date && session.time === target.time,
        );
        if (matches.length !== 1 || matches[0]!.name !== target.sessionName) {
            return { status: "stop", reason: "activity-session-mismatch" };
        }
    }
    return { status: "pending", reason: "selection-not-ready" };
}
