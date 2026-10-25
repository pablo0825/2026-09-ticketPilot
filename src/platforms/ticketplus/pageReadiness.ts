import { parseTicketSelectionPage } from "./ticketSelectionPage.js";
import { matchesSubmittedSelection } from "./submissionValidation.js";
import type { SubmittedSelectionTarget } from "./submissionValidation.js";
import { normalizeSessionName, parseActivityPage } from "./activityPage.js";
import { readEventDetails } from "./readResult.js";
import type { TicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusPage } from "./pageState.js";
import { isActivityFullyLoaded } from "./activityLoading.js";
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

    // 只有已知提醒時交由選場次關閉；與其他彈窗並存仍停止。
    if (result.kind === "unknown" && result.reason === "notice-dialog") {
        return { status: "pending", reason: "notice-dialog" };
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

    // 依場次名稱等待目標，不以活動頁的一級標題判定身分。
    if (result.kind === "unknown" && ["read-failed", "page-changed"].includes(result.reason)) {
        return { status: "stop", reason: result.reason };
    }

    const matches = dom.activity.filter(row =>
        row.names.some(name => normalizeSessionName(name) === normalizeSessionName(target.eventName)),
    );
    // 列表已完整載入仍無同名列時立即停止；仍在載入才繼續等待。
    if (matches.length === 0) {
        return isActivityFullyLoaded(dom)
            ? { status: "stop", reason: "session-missing" }
            : { status: "pending", reason: "activity-not-ready" };
    }
    if (matches.length > 1 || (result.kind === "unknown" && result.reason === "ambiguous-data")) {
        return { status: "stop", reason: "session-ambiguous" };
    }
    if (matches[0]!.timeRanges.length > 0) return { status: "stop", reason: "session-time-invalid" };

    return result.kind === "activity"
        ? { status: "ready", reason: "activity-parsed" }
        : { status: "pending", reason: "activity-not-ready" };
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
    if (result.kind === "ticket-selection") return { status: "ready", reason: "selection-parsed" };

    const details = readEventDetails(dom);
    if (
        details &&
        (details.eventName !== target.eventName || details.date !== target.date || details.time !== target.time)
    ) {
        return { status: "stop", reason: "selection-identity-mismatch" };
    }

    const matchingRows = dom.activity.filter(row =>
        row.names.some(name => normalizeSessionName(name) === normalizeSessionName(target.eventName)),
    );
    if (matchingRows.length > 1) return { status: "stop", reason: "activity-session-mismatch" };

    const activity = parseActivityPage(dom, target.eventId, target.eventName);
    if (activity.kind === "activity") {
        const matches = activity.sessions.filter(
            session => session.date === target.date && session.time === target.time,
        );
        if (
            matches.length !== 1 ||
            normalizeSessionName(matches[0]!.name) !== normalizeSessionName(target.sessionName)
        ) {
            return { status: "stop", reason: "activity-session-mismatch" };
        }
    }

    return { status: "pending", reason: "selection-not-ready" };
}

export function informationReadiness(
    dom: TicketPlusDom | undefined,
    result: TicketPlusPage,
    target: SubmittedSelectionTarget,
): PageReadiness {
    // 網址仍須同場次；排隊與失敗沿用原本分支及額度。
    if (!dom) return { status: "pending", reason: "read-failed" };

    const route = /^\/(order|confirmSeat|confirm)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(dom.pathname);
    if (
        dom.origin !== "https://ticketplus.com.tw" ||
        dom.extraUrlParts ||
        route?.[2] !== target.eventId ||
        route[3] !== target.sessionId
    ) {
        return { status: "stop", reason: "route-mismatch" };
    }
    if (result.kind === "queue" || result.kind === "order-failure") {
        return { status: "pending", reason: result.kind };
    }

    // 確認選位結果交由提交流程核對座位；不在此判斷是否抵達資料頁。
    if (result.kind === "seat-confirmation") return { status: "ready", reason: "seat-confirmation" };
    if (
        dom.dialogs.length ||
        dom.queueCount ||
        dom.activity.length ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount
    ) {
        return { status: "stop", reason: "conflicting-content" };
    }

    // 即使資料與選票內容重疊，完整的殘留選票資料仍須符合本次提交。
    const details = readEventDetails(dom);
    if (
        details &&
        (details.eventName !== target.eventName || details.date !== target.date || details.time !== target.time)
    ) {
        return { status: "stop", reason: "selection-mismatch" };
    }

    const selection = parseTicketSelectionPage(dom, { eventId: route[2]!, sessionId: route[3]! });
    if (selection.kind === "ticket-selection" && !matchesSubmittedSelection(selection, target)) {
        return { status: "stop", reason: "selection-mismatch" };
    }

    return result.kind === "information"
        ? { status: "ready", reason: "information-parsed" }
        : { status: "pending", reason: "information-not-ready" };
}
