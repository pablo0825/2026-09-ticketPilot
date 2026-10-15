import type { Page } from "playwright";
import { inspectActivityLoading } from "./activityLoading.js";
import type { ActivityLoading, ActivityLoadingTarget } from "./activityLoading.js";
import { readTicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusDom } from "./domSnapshot.js";
import { diagnoseActivityFields, parseActivityPage } from "./activityPage.js";
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
    routeKind?: "activity" | "order" | "confirm" | "checkout" | "other";
    unknownReason?: UnknownPage["reason"];
    selectionTransition?: SelectionTransitionCheck;
    emptyActivityLoading?: boolean;
    activityLoading?: ActivityLoading;
    activityFields?: ReturnType<typeof diagnoseActivityFields>;
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

export interface SelectionTransitionTarget extends PageIdentity {
    eventName: string;
    date: string;
    time: string;
    ticketType: string;
    quantity: number;
}

type SelectionTransitionCheck =
    "verified" | "mixed-markers" | "incomplete-selection" | "identity-mismatch" | "selection-mismatch";

function inspectSelectionTransition(
    dom: TicketPlusDom,
    identity: PageIdentity,
    target: SelectionTransitionTarget,
): SelectionTransitionCheck {
    // 只接受純選票殘留，不能忽略排隊、彈窗或已出現的資料／付款內容。
    if (
        dom.activity.length ||
        dom.queueCount ||
        dom.dialogs.length ||
        dom.information.headingCount ||
        dom.information.terms.length ||
        dom.information.contact.some(fields => fields.length > 0) ||
        dom.paymentButtons.length ||
        dom.checkoutStepCount ||
        dom.checkout.length
    ) {
        return "mixed-markers";
    }

    // 完整解析殘留選票資料，再核對本次提交的活動與場次。
    const selection = parseTicketSelectionPage(dom, identity);
    if (selection.kind !== "ticket-selection") return "incomplete-selection";
    if (
        selection.eventId !== target.eventId ||
        selection.sessionId !== target.sessionId ||
        selection.eventName !== target.eventName ||
        selection.date !== target.date ||
        selection.time !== target.time
    ) {
        return "identity-mismatch";
    }

    // 目標票種唯一且張數相符，其他票種必須維持零張。
    const matches = selection.tickets.filter(ticket => ticket.name === target.ticketType);
    if (
        matches.length !== 1 ||
        matches[0]!.saleStatus !== "selling" ||
        matches[0]!.selectedQuantity !== target.quantity ||
        selection.tickets.some(ticket => ticket !== matches[0] && ticket.selectedQuantity !== 0)
    ) {
        return "selection-mismatch";
    }
    return "verified";
}

function classifyPage(
    dom: TicketPlusDom,
    transitionTarget?: ActivityTransitionTarget,
    selectionTarget?: SelectionTransitionTarget,
): TicketPlusPage {
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
    // 僅提交後等待可提供目標；一般 reader 不放寬 confirm 路徑的選票殘留。
    if (
        order![1] === "confirm" &&
        dom.tickets.length > 0 &&
        selectionTarget &&
        inspectSelectionTransition(dom, identity, selectionTarget) === "verified"
    ) {
        return unknownPage("selection-transition");
    }
    if (dom.queueCount || dom.tickets.length) return unknownPage("conflicting-page");
    if (order![1] === "confirm") {
        // 資料頁可以有摘要列，但付款操作標記仍屬衝突。
        const hasPaymentControls = dom.checkoutStepCount > 0 || dom.paymentButtons.length > 0;
        return hasPaymentControls ? unknownPage("conflicting-page") : parseInformationPage(dom, identity);
    }
    return hasInformation ? unknownPage("conflicting-page") : parseCheckoutPage(dom, identity);
}

function diagnosticRouteKind(pathname: string): TicketPlusPageDiagnostic["routeKind"] {
    if (/^\/activity\/[A-Za-z0-9_-]+\/?$/.test(pathname)) return "activity";
    for (const kind of ["order", "confirm", "checkout"] as const) {
        if (new RegExp(`^/${kind}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/?$`).test(pathname)) return kind;
    }
    return "other";
}

interface PageObservationOptions {
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void;
    transitionTarget?: ActivityTransitionTarget;
    selectionTarget?: SelectionTransitionTarget;
    activityName?: string;
    activityTarget?: ActivityLoadingTarget;
}

export interface ActivityObservation {
    page: TicketPlusPage;
    loading: ActivityLoading;
}

// 既有 reader 保留分類與呼叫介面，不因活動載入證據放寬解析。
export async function readTicketPlusPage(
    page: Page,
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void,
    transitionTarget?: ActivityTransitionTarget,
    selectionTarget?: SelectionTransitionTarget,
    activityName?: string,
): Promise<TicketPlusPage> {
    const observation = await readPageObservation(page, {
        onDiagnostic,
        transitionTarget,
        selectionTarget,
        activityName,
    });
    return observation.page;
}

// 點擊前專用入口：等待證據直接回傳，不依賴診斷回呼。
export async function readTicketPlusActivityObservation(
    page: Page,
    target: ActivityLoadingTarget,
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void,
): Promise<ActivityObservation> {
    return readPageObservation(page, { onDiagnostic, activityName: target.eventName, activityTarget: target });
}

async function readPageObservation(page: Page, options: PageObservationOptions): Promise<ActivityObservation> {
    const { onDiagnostic, transitionTarget, selectionTarget, activityName, activityTarget } = options;
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
            result = classifyPage(snapshot, transitionTarget, selectionTarget);
        }
    } catch {
        result = unknownPage("read-failed");
    }

    // 載入判斷與分類使用同一份快照，讀取失敗或切頁時不授予等待資格。
    let loading: ActivityLoading = "none";
    if (
        snapshot &&
        activityName !== undefined &&
        result.kind === "unknown" &&
        ["incomplete-data", "ambiguous-data"].includes(result.reason)
    ) {
        const eventId = /^\/activity\/([A-Za-z0-9_-]+)\/?$/.exec(snapshot.pathname)?.[1] ?? "";
        loading = inspectActivityLoading(snapshot, activityTarget ?? { eventId, eventName: activityName });
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
        if (snapshot && selectionTarget && snapshot.tickets.length > 0) {
            const confirm = /^\/confirm\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?$/.exec(snapshot.pathname);
            if (confirm) {
                diagnostic.selectionTransition = inspectSelectionTransition(
                    snapshot,
                    { eventId: confirm[1]!, sessionId: confirm[2]! },
                    selectionTarget,
                );
            }
        }
        if (snapshot && activityName !== undefined) {
            diagnostic.activityFields = diagnoseActivityFields(snapshot, activityName);
            diagnostic.emptyActivityLoading = loading === "empty";
            if (activityTarget) diagnostic.activityLoading = loading;
        }
        if (snapshot) {
            diagnostic.routeKind = diagnosticRouteKind(snapshot.pathname);
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
    return { page: result, loading };
}
