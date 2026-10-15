import type { Page } from "playwright";
import { readTicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusDom } from "./domSnapshot.js";
import { parseActivityPage } from "./activityPage.js";
import { parseTicketSelectionPage } from "./ticketSelectionPage.js";
import { parseInformationPage } from "./informationPage.js";
import { parseCheckoutPage } from "./checkoutPage.js";
import { unknownPage } from "./readResult.js";
import type { UnknownPage, PageIdentity } from "./readResult.js";
import type { ActivityPage } from "./activityPage.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";
import type { InformationPage } from "./informationPage.js";
import type { CheckoutPage } from "./checkoutPage.js";

export interface OrderFailurePage extends PageIdentity {
    kind: "order-failure";
    failure: "sold-out" | "purchase-failed";
    dialogIndex: number;
    messageKey: string;
    dismissNames: string[];
}

export type TicketPlusPage =
    | OrderFailurePage
    | ActivityPage
    | TicketSelectionPage
    | InformationPage
    | CheckoutPage
    | (PageIdentity & { kind: "queue" })
    | UnknownPage;

export interface TicketPlusPageDiagnostic {
    pageKind: TicketPlusPage["kind"];
    unknownReason?: UnknownPage["reason"];
    activityTransition?: ActivityTransitionDiagnostic & {
        headingCount: number;
        matchingHeadingCount: number;
        rows: { names: number; dates: number; times: number; buttons: number; knownButtonText: boolean }[];
    };
    informationControls?: {
        nextButtons: number;
        nameFields: number;
        phoneFields: number;
        emailFields: number;
    };
    markers?: {
        activityRows: number;
        ticketRows: number;
        queueHeadings: number;
        unknownDialogs: number;
        failureDialogs: number;
        queueDialogs: number;
        informationHeadings: number;
        terms: number;
        paymentButtons: number;
        checkoutSteps: number;
        checkoutRows: number;
    };
}

// 僅進入選票頁的等待階段提供，其他流程仍將殘留活動列視為衝突。
export interface ActivityTransitionTarget {
    eventId: string;
    eventName: string;
    sessionName: string;
    date: string;
    time: string;
}

interface ActivityTransitionDiagnostic {
    result:
        | "verified"
        | "unsupported-transition-route"
        | "event-id-mismatch"
        | "mixed-markers"
        | "activity-unreadable"
        | "event-name-mismatch"
        | "target-session-missing"
        | "target-session-ambiguous"
        | "session-name-mismatch";
    activityReadReason?: UnknownPage["reason"];
}

function inspectActivityTransition(
    dom: TicketPlusDom,
    eventId: string,
    target: ActivityTransitionTarget,
): ActivityTransitionDiagnostic {
    // 只有活動列殘留可以等待，其他流程標記或任何彈窗都不能放行。
    if (eventId !== target.eventId) return { result: "event-id-mismatch" };
    if (
        dom.dialogs.length ||
        dom.queueCount ||
        dom.tickets.length ||
        dom.information.headingCount ||
        dom.information.terms.length ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount ||
        dom.checkout.length
    ) {
        return { result: "mixed-markers" };
    }

    // 過渡時允許同活動標題重複，但每個標題都必須完全符合目標。
    const repeatedTargetHeading =
        dom.activityNames.length > 1 && dom.activityNames.every(name => name === target.eventName);
    const activityDom = repeatedTargetHeading ? { ...dom, activityNames: [target.eventName] } : dom;

    // 以同份快照核對活動及唯一目標場次，不依殘留列數猜測身分。
    const activity = parseActivityPage(activityDom, eventId);
    if (activity.kind !== "activity") return { result: "activity-unreadable", activityReadReason: activity.reason };
    if (activity.eventName !== target.eventName) return { result: "event-name-mismatch" };
    const matches = activity.sessions.filter(session => session.date === target.date && session.time === target.time);
    if (matches.length === 0) return { result: "target-session-missing" };
    if (matches.length !== 1) return { result: "target-session-ambiguous" };
    return { result: matches[0]!.name === target.sessionName ? "verified" : "session-name-mismatch" };
}

function classifyPage(dom: TicketPlusDom, transitionTarget?: ActivityTransitionTarget): TicketPlusPage {
    // 網址採明確白名單，不接受其他站台、額外路徑或不明參數。
    if (dom.origin !== "https://ticketplus.com.tw" || dom.extraUrlParts) return unknownPage("unsupported-url");
    const activity = /^\/activity\/([A-Za-z0-9_-]+)\/?$/.exec(dom.pathname);
    const order = /^\/(order|confirm|checkout)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(dom.pathname);
    if (!activity && !order) return unknownPage("unsupported-url");

    // 僅同 order 頁可辨識失敗；資料頁帶彈窗不能誤報抵達成功。
    if (dom.dialogs.length > 0) {
        const failures = dom.dialogs.filter(dialog => dialog.kind === "failure");
        const queues = dom.dialogs.filter(dialog => dialog.kind === "queue");
        if (failures.length > 1 || queues.length > 1) return unknownPage("ambiguous-data");
        if (dom.dialogs.some(dialog => dialog.kind === "unknown")) return unknownPage("blocking-dialog");
        if (!order || order[1] !== "order") return unknownPage("conflicting-page");
        if (failures.length === 1) {
            if (
                dom.activity.length ||
                dom.information.headingCount ||
                dom.information.terms.length ||
                dom.paymentButtons.length ||
                dom.checkoutStepCount ||
                dom.checkout.length
            ) {
                return unknownPage("conflicting-page");
            }
            const failure = failures[0]!;
            return {
                kind: "order-failure",
                eventId: order[2]!,
                sessionId: order[3]!,
                failure: failure.failure!,
                dialogIndex: failure.index,
                messageKey: failure.messageKey!,
                dismissNames: failure.dismissNames,
            };
        }
    }

    // 排隊只適用 order；其他跨頁標記並存時保守回報衝突。
    const hasInformation = dom.information.headingCount > 0 || dom.information.terms.length > 0;
    const hasCheckout = dom.checkoutStepCount > 0 || dom.paymentButtons.length > 0 || dom.checkout.length > 0;
    if (activity) {
        if (dom.queueCount || dom.tickets.length || hasInformation || hasCheckout) {
            return unknownPage("conflicting-page");
        }
        // 點擊後可能先重疊同名標題，再切換網址；仍須核對完整活動與場次。
        if (
            transitionTarget &&
            dom.activityNames.length > 1 &&
            inspectActivityTransition(dom, activity[1]!, transitionTarget).result === "verified"
        ) {
            return unknownPage("activity-transition");
        }
        return parseActivityPage(dom, activity[1]!);
    }
    const identity = { eventId: order![2]!, sessionId: order![3]! };
    if (dom.activity.length) {
        if (
            order![1] === "order" &&
            transitionTarget &&
            inspectActivityTransition(dom, identity.eventId, transitionTarget).result === "verified"
        ) {
            return unknownPage("activity-transition");
        }
        return unknownPage("conflicting-page");
    }
    if (order![1] === "order") {
        if (hasInformation || hasCheckout) return unknownPage("conflicting-page");
        if (dom.queueCount > 1) return unknownPage("ambiguous-data");
        if (dom.queueCount === 1) return { kind: "queue", ...identity };
        return parseTicketSelectionPage(dom, identity);
    }
    if (dom.queueCount || dom.tickets.length) return unknownPage("conflicting-page");
    if (order![1] === "confirm") {
        return hasCheckout ? unknownPage("conflicting-page") : parseInformationPage(dom, identity);
    }
    return hasInformation ? unknownPage("conflicting-page") : parseCheckoutPage(dom, identity);
}

// 對外唯一的唯讀入口：取得一份快照後分流，不在頁面辨識後重讀整頁。
// unknown 不是售完或終局失敗；等待、重試與點擊由未來的流程層決定。
export async function readTicketPlusPage(
    page: Page,
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void,
    transitionTarget?: ActivityTransitionTarget,
): Promise<TicketPlusPage> {
    // 沿用同一份快照判讀，不為診斷重讀頁面。
    let snapshot: TicketPlusDom | undefined;
    let result: TicketPlusPage;
    try {
        const before = page.url();
        snapshot = await readTicketPlusDom(page);
        const after = page.url();
        if (
            before !== after ||
            new URL(after).origin !== snapshot.origin ||
            new URL(after).pathname !== snapshot.pathname
        ) {
            result = unknownPage("page-changed");
        } else {
            result = classifyPage(snapshot, transitionTarget);
        }
    } catch {
        result = unknownPage("read-failed");
    }

    // 只保留分類與計數，不帶出網址、頁面文字或個資。
    if (onDiagnostic) {
        const diagnostic: TicketPlusPageDiagnostic = { pageKind: result.kind };
        if (result.kind === "unknown") diagnostic.unknownReason = result.reason;
        if (snapshot && transitionTarget && snapshot.activity.length) {
            const order = /^\/order\/([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+\/?$/.exec(snapshot.pathname);
            const activity = /^\/activity\/([A-Za-z0-9_-]+)\/?$/.exec(snapshot.pathname);
            const eventId = order?.[1] ?? activity?.[1];
            diagnostic.activityTransition = {
                ...(eventId
                    ? inspectActivityTransition(snapshot, eventId, transitionTarget)
                    : { result: "unsupported-transition-route" as const }),
                headingCount: snapshot.activityNames.length,
                matchingHeadingCount: snapshot.activityNames.filter(name => name === transitionTarget.eventName).length,
                rows: snapshot.activity.map(row => ({
                    names: row.names.length,
                    dates: row.dates.length,
                    times: row.times.length,
                    buttons: row.saleButtons.length,
                    knownButtonText:
                        row.saleButtons.length === 1 && ["立即購買", "尚未開賣"].includes(row.saleButtons[0]!.text),
                })),
            };
        }
        if (snapshot) {
            diagnostic.informationControls = {
                nextButtons: snapshot.nextButtons.length,
                nameFields: snapshot.information.contact[0]!.length,
                phoneFields: snapshot.information.contact[1]!.length,
                emailFields: snapshot.information.contact[2]!.length,
            };
            diagnostic.markers = {
                activityRows: snapshot.activity.length,
                ticketRows: snapshot.tickets.length,
                queueHeadings: snapshot.queueCount,
                unknownDialogs: snapshot.dialogs.filter(dialog => dialog.kind === "unknown").length,
                failureDialogs: snapshot.dialogs.filter(dialog => dialog.kind === "failure").length,
                queueDialogs: snapshot.dialogs.filter(dialog => dialog.kind === "queue").length,
                informationHeadings: snapshot.information.headingCount,
                terms: snapshot.information.terms.length,
                paymentButtons: snapshot.paymentButtons.length,
                checkoutSteps: snapshot.checkoutStepCount,
                checkoutRows: snapshot.checkout.length,
            };
        }
        try {
            onDiagnostic(diagnostic);
        } catch {
            // 診斷接收失敗不能改變購票判斷。
        }
    }
    return result;
}
