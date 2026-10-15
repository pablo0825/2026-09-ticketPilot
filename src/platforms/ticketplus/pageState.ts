import { activityReadiness, selectionReadiness } from "./pageReadiness.js";
import type { PageReadiness, SelectionEntryTarget } from "./pageReadiness.js";
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
    readiness?: PageReadiness;
    routeKind?: "activity" | "order" | "confirm" | "checkout" | "other";
    unknownReason?: UnknownPage["reason"];
    selectionTransition?: SelectionTransitionCheck;
    emptyActivityLoading?: boolean;
    activityLoading?: ActivityLoading;
    activityFields?: ReturnType<typeof diagnoseActivityFields>;
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

function classifyPage(dom: TicketPlusDom, selectionTarget?: SelectionTransitionTarget): TicketPlusPage {
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
        return parseActivityPage(dom, activity[1]!);
    }
    const identity = { eventId: order![2]!, sessionId: order![3]! };
    if (dom.activity.length) {
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
    entryTarget?: SelectionEntryTarget;
    selectionTarget?: SelectionTransitionTarget;
    activityName?: string;
    activityTarget?: ActivityLoadingTarget;
}

export interface ActivityObservation {
    page: TicketPlusPage;
    loading: ActivityLoading;
    readiness: PageReadiness;
}

// 既有 reader 保留分類與呼叫介面，不因活動載入證據放寬解析。
export async function readTicketPlusPage(
    page: Page,
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void,
    selectionTarget?: SelectionTransitionTarget,
    activityName?: string,
): Promise<TicketPlusPage> {
    const observation = await readPageObservation(page, {
        onDiagnostic,
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

// 點擊後只等嚴格選票頁，不修改一般 reader 的分類。
export async function readTicketPlusSelectionObservation(
    page: Page,
    target: SelectionEntryTarget,
    onDiagnostic?: (diagnostic: TicketPlusPageDiagnostic) => void,
): Promise<ActivityObservation> {
    return readPageObservation(page, { onDiagnostic, entryTarget: target, activityName: target.eventName });
}

async function readPageObservation(page: Page, options: PageObservationOptions): Promise<ActivityObservation> {
    const { onDiagnostic, entryTarget, selectionTarget, activityName, activityTarget } = options;
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
            result = classifyPage(snapshot, selectionTarget);
        }
    } catch {
        result = unknownPage("read-failed");
    }

    // 舊載入診斷沿用同份快照；切頁與讀取失敗不標記已知佔位。
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

    const readiness: PageReadiness = activityTarget
        ? activityReadiness(snapshot, result, activityTarget)
        : entryTarget
          ? selectionReadiness(snapshot, result, entryTarget)
          : { status: "stop", reason: "not-requested" };

    // 只保留分類與計數，不帶出網址、頁面文字或個資。
    if (onDiagnostic) {
        const diagnostic: TicketPlusPageDiagnostic = { pageKind: result.kind };
        if (activityTarget || entryTarget) diagnostic.readiness = readiness;
        if (result.kind === "unknown") diagnostic.unknownReason = result.reason;
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
    return { page: result, loading, readiness };
}
