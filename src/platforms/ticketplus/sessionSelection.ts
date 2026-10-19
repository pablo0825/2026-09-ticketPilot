import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import type { Locator, Page } from "playwright";
import { parseTicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { TicketPlusFlowType, TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import { normalizeSessionName } from "./activityPage.js";
import type { ActivityPage } from "./activityPage.js";
import { dismissTicketPlusActivityNotice, TicketPlusNoticeError } from "./activityNotice.js";
import { readTicketPlusActivityObservation, readTicketPlusSelectionObservation } from "./pageState.js";
import type { TicketPlusPageDiagnostic, TicketPlusPage } from "./pageState.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";

type Session = ActivityPage["sessions"][number];
export type SessionEntryStage = "before-click" | "after-click-attempt";
export type SessionEntryReason =
    | "invalid-settings"
    | "invalid-options"
    | "unexpected-page"
    | "activity-mismatch"
    | "session-date-mismatch"
    | "session-time-mismatch"
    | "session-time-invalid"
    | "session-missing"
    | "session-ambiguous"
    | "session-disabled"
    | "not-on-sale"
    | "session-changed"
    | "button-unavailable"
    | "click-failed"
    | "arrival-mismatch"
    | "arrival-timeout"
    | "activity-ready-timeout"
    | "notice-dismiss-failed"
    | "flow-mismatch"
    | "read-failed";

export type SessionDiagnostic =
    | {
          check: "page-state";
          snapshot: TicketPlusPageDiagnostic;
          activityWait?: ActivityWaitDiagnostic;
          recentObservations?: RecentObservation[];
      }
    | { check: "arrival-route"; reason: "origin-mismatch" | "extra-url-parts" | "path-mismatch" };

export interface RecentObservation {
    observation: number;
    elapsedMs: number;
    stage: SessionEntryStage;
    pageKind: TicketPlusPageDiagnostic["pageKind"];
    unknownReason?: TicketPlusPageDiagnostic["unknownReason"];
    readiness?: TicketPlusPageDiagnostic["readiness"];
    readFailure?: TicketPlusPageDiagnostic["readFailure"];
}

export class TicketPlusSessionError extends Error {
    constructor(
        public readonly stage: SessionEntryStage,
        public readonly reason: SessionEntryReason,
        public diagnostic?: SessionDiagnostic,
    ) {
        super(
            stage === "before-click"
                ? `TicketPlus 場次選擇停止（${reason}），尚未嘗試點擊。`
                : `TicketPlus 已嘗試進入場次（${reason}），請人工確認；不會重新點擊。`,
        );
        this.name = "TicketPlusSessionError";
    }
}

export interface ActivityWaitDiagnostic {
    elapsedMs: number;
    observations: number;
}

export interface SessionSelectionOptions {
    activityReadyTimeoutMs?: number;
    activityPollIntervalMs?: number;
    onActivityWait?: (diagnostic: ActivityWaitDiagnostic) => void;
    clickTimeoutMs?: number;
    arrivalTimeoutMs?: number;
    pollIntervalMs?: number;
    // 未指定時視為購票，既有呼叫不受影響。
    flowType?: TicketPlusFlowType;
}

const entryButtonText = { purchase: "立即購買", lottery: "立即登記" } as const;

function requireTargetSession(
    snapshot: TicketPlusPage,
    settings: TicketPlusSelection,
    flowType: TicketPlusFlowType,
): Session {
    // 先核對活動網址，再以設定名稱找唯一場次。
    if (snapshot.kind !== "activity") throw new TicketPlusSessionError("before-click", "unexpected-page");
    const eventId = new URL(settings.eventUrl).pathname.split("/")[2];
    if (snapshot.eventId !== eventId) {
        throw new TicketPlusSessionError("before-click", "activity-mismatch");
    }
    const matches = snapshot.sessions.filter(
        session => normalizeSessionName(session.name) === normalizeSessionName(settings.eventName),
    );
    if (matches.length === 0) throw new TicketPlusSessionError("before-click", "session-missing");
    if (matches.length !== 1) throw new TicketPlusSessionError("before-click", "session-ambiguous");

    // 停用列也參與唯一性檢查，不能先排除它來消除歧義。
    const session = matches[0]!;
    if (session.date !== settings.target.date) {
        throw new TicketPlusSessionError("before-click", "session-date-mismatch");
    }
    if (session.time !== settings.target.time) {
        throw new TicketPlusSessionError("before-click", "session-time-mismatch");
    }
    if (session.saleState === "not-on-sale") throw new TicketPlusSessionError("before-click", "not-on-sale");
    if (session.buttonText !== entryButtonText[flowType]) {
        throw new TicketPlusSessionError("before-click", "flow-mismatch");
    }
    if (!session.buyEnabled) throw new TicketPlusSessionError("before-click", "session-disabled");
    return session;
}

function exactText(value: string): RegExp {
    return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

function sessionNamePattern(value: string): RegExp {
    const words = normalizeSessionName(value).split(" ");
    const pattern = words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    return new RegExp(`^\\s*${pattern}\\s*$`);
}

function sessionButton(page: Page, session: Session, flowType: TicketPlusFlowType): Locator {
    // 定位條件隨 DOM 重新解析，不保存列表索引，也不使用整列模糊文字。
    const body = page.locator("body");
    const date = new RegExp(`^\\s*${session.date}(?:\\([一二三四五六日]\\))?\\s*$`);
    const row = body
        .locator(".sesstion-item")
        .filter({ visible: true })
        .filter({
            has: page
                .locator(".font-weight-bold.is-word-break")
                .filter({ visible: true, hasText: sessionNamePattern(session.name) }),
        })
        .filter({ has: page.getByText(date).filter({ visible: true }) })
        .filter({ has: page.getByText(exactText(session.time)).filter({ visible: true }) });
    return row.getByRole("button", { name: entryButtonText[flowType], exact: true }).filter({ visible: true });
}

function arrivalRouteFailure(page: Page, settings: TicketPlusSelection): SessionDiagnostic | undefined {
    const current = new URL(page.url());
    const expected = new URL(settings.eventUrl);
    if (current.origin !== expected.origin) return { check: "arrival-route", reason: "origin-mismatch" };
    if (current.search || current.hash || current.username || current.password) {
        return { check: "arrival-route", reason: "extra-url-parts" };
    }
    const eventId = expected.pathname.split("/")[2]!;
    const matches =
        current.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") ||
        new RegExp(`^/order/${eventId}/[A-Za-z0-9_-]+/?$`).test(current.pathname);
    return matches ? undefined : { check: "arrival-route", reason: "path-mismatch" };
}

// 逾時後可能仍有唯讀 evaluate 收尾，但不會繼續點擊或變更頁面。
async function readWithinDeadline<T>(
    timeout: number,
    stage: SessionEntryStage,
    control: TicketPlusRunControl,
    read: () => Promise<T>,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await control.read(() =>
            Promise.race([
                read(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new TicketPlusSessionError(
                                    stage,
                                    stage === "before-click" ? "read-failed" : "arrival-timeout",
                                ),
                            ),
                        Math.max(1, timeout),
                    );
                }),
            ]),
        );
    } finally {
        clearTimeout(timer);
    }
}

interface ActivityWaitState {
    started: number;
    deadline: number;
    observations: number;
}

function requireActivityRoute(page: Page, settings: TicketPlusSelection): void {
    const current = new URL(page.url());
    const expected = new URL(settings.eventUrl);
    if (current.origin !== expected.origin || current.search || current.hash || current.username || current.password) {
        throw new TicketPlusSessionError("before-click", "unexpected-page");
    }
    if (current.pathname.replace(/\/$/, "") !== expected.pathname.replace(/\/$/, "")) {
        throw new TicketPlusSessionError("before-click", "activity-mismatch");
    }
}

// 關閉已知提醒；每次載入的點擊額度由關閉模組記在頁面上，同一次載入再出現或關閉失敗都在點擊前停止。
async function dismissNotice(page: Page, state: ActivityWaitState, control: TicketPlusRunControl): Promise<void> {
    try {
        await dismissTicketPlusActivityNotice(page, control, {
            timeoutMs: Math.max(1, Math.min(5_000, state.deadline - performance.now())),
        });
    } catch (error) {
        if (error instanceof TicketPlusNoticeError) {
            throw new TicketPlusSessionError("before-click", "notice-dismiss-failed");
        }
        throw error;
    }
}

async function waitForActivitySession(
    page: Page,
    settings: TicketPlusSelection,
    flowType: TicketPlusFlowType,
    state: ActivityWaitState,
    interval: number,
    readTimeout: number,
    control: TicketPlusRunControl,
    onDiagnostic: (diagnostic: TicketPlusPageDiagnostic) => void,
): Promise<Session> {
    // 兩次點擊前核對共用期限，等待同活動內容完整。
    while (performance.now() < state.deadline) {
        control.check();
        if (page.isClosed()) throw new TicketPlusSessionError("before-click", "unexpected-page");
        requireActivityRoute(page, settings);
        state.observations++;
        const observation = await readWithinDeadline(
            Math.min(readTimeout, state.deadline - performance.now()),
            "before-click",
            control,
            () =>
                readTicketPlusActivityObservation(
                    page,
                    {
                        eventId: new URL(settings.eventUrl).pathname.split("/")[2]!,
                        eventName: settings.eventName,
                    },
                    onDiagnostic,
                ),
        );
        requireActivityRoute(page, settings);
        if (performance.now() >= state.deadline) break;

        // 先排除阻擋條件，完整頁面仍沿用活動與場次核對。
        if (observation.readiness.status === "stop") {
            const reason = observation.readiness.reason;
            throw new TicketPlusSessionError(
                "before-click",
                reason === "session-ambiguous" || reason === "session-time-invalid" ? reason : "unexpected-page",
            );
        }
        if (observation.readiness.status === "pending" && observation.readiness.reason === "notice-dialog") {
            await dismissNotice(page, state, control);
            continue;
        }
        if (observation.page.kind === "activity") return requireTargetSession(observation.page, settings, flowType);
        await control.wait(Math.min(interval, Math.max(0, state.deadline - performance.now())));
    }
    throw new TicketPlusSessionError("before-click", "activity-ready-timeout");
}

async function waitForSelection(
    page: Page,
    settings: TicketPlusSelection,
    timeout: number,
    interval: number,
    control: TicketPlusRunControl,
    onDiagnostic: (diagnostic: TicketPlusPageDiagnostic) => void,
    target: Session,
): Promise<TicketSelectionPage> {
    // 只設一次期限，暫時缺資料不會延長等待，也不會回到點擊流程。
    const deadline = performance.now() + timeout;
    const eventId = new URL(settings.eventUrl).pathname.split("/")[2];
    while (performance.now() < deadline) {
        control.check();
        if (page.isClosed()) throw new TicketPlusSessionError("after-click-attempt", "read-failed");
        const routeFailure = arrivalRouteFailure(page, settings);
        if (routeFailure) {
            throw new TicketPlusSessionError("after-click-attempt", "unexpected-page", routeFailure);
        }
        const observation = await readWithinDeadline(deadline - performance.now(), "after-click-attempt", control, () =>
            readTicketPlusSelectionObservation(
                page,
                {
                    eventId: eventId!,
                    eventName: settings.eventName,
                    sessionName: target.name,
                    date: target.date,
                    time: target.time,
                },
                onDiagnostic,
            ),
        );
        const changedRoute = arrivalRouteFailure(page, settings);
        if (changedRoute) throw new TicketPlusSessionError("after-click-attempt", "unexpected-page", changedRoute);
        if (performance.now() >= deadline) break;
        const snapshot = observation.page;
        if (observation.readiness.status === "stop") {
            throw new TicketPlusSessionError("after-click-attempt", "unexpected-page");
        }

        // 完整選票頁必須符合活動與日期時間；sessionId 是此時新取得的資料。
        if (snapshot.kind === "ticket-selection") {
            if (
                snapshot.eventId !== eventId ||
                snapshot.eventName !== settings.eventName ||
                snapshot.date !== settings.target.date ||
                snapshot.time !== settings.target.time
            ) {
                throw new TicketPlusSessionError("after-click-attempt", "arrival-mismatch");
            }
            return snapshot;
        }
        // 等待期間不刷新、不處理排隊，也不碰選票頁的任何控制項。
        await control.wait(Math.min(interval, Math.max(0, deadline - performance.now())));
    }
    throw new TicketPlusSessionError("after-click-attempt", "arrival-timeout");
}

// 前提是使用者已手動登入並停在活動頁。單次呼叫最多一次 click；跨呼叫防重複由未來 runner 負責。
export async function selectTicketPlusSession(
    page: Page,
    input: TicketPlusSelection,
    options: SessionSelectionOptions = {},
    control = new TicketPlusRunControl(),
): Promise<TicketSelectionPage> {
    let stage: SessionEntryStage = "before-click";
    let reason: SessionEntryReason = "invalid-settings";
    let diagnostic: SessionDiagnostic | undefined;
    let activityWait: ActivityWaitState | undefined;
    let waitReported = false;
    const reportActivityWait = () => {
        if (!activityWait || waitReported) return;
        waitReported = true;
        const summary = {
            elapsedMs: Math.round(performance.now() - activityWait.started),
            observations: activityWait.observations,
        };
        if (diagnostic?.check === "page-state") diagnostic.activityWait = summary;
        try {
            options.onActivityWait?.(summary);
        } catch {
            /* 診斷通知不控制購票。 */
        }
    };
    const recentObservations: RecentObservation[] = [];
    let observed = 0;
    const onDiagnostic = (snapshot: TicketPlusPageDiagnostic) => {
        // 僅摘要既有觀測，最多保留八筆；不重讀頁面也不參與等待決策。
        recentObservations.push({
            observation: ++observed,
            elapsedMs: activityWait ? Math.round(performance.now() - activityWait.started) : 0,
            stage,
            pageKind: snapshot.pageKind,
            ...(snapshot.unknownReason ? { unknownReason: snapshot.unknownReason } : {}),
            ...(snapshot.readiness ? { readiness: { ...snapshot.readiness } } : {}),
            ...(snapshot.readFailure ? { readFailure: { ...snapshot.readFailure } } : {}),
        });
        if (recentObservations.length > 8) recentObservations.shift();
        diagnostic = { check: "page-state", snapshot, recentObservations: [...recentObservations] };
    };
    try {
        // 複製並驗證設定，操作途中不受呼叫端修改設定影響。
        control.check();
        const settings = parseTicketPlusSelection(input);
        const flowType = options.flowType ?? "purchase";
        const clickTimeout = options.clickTimeoutMs ?? 5_000;
        const arrivalTimeout = options.arrivalTimeoutMs ?? 15_000;
        const interval = options.pollIntervalMs ?? 100;
        const activityTimeout = options.activityReadyTimeoutMs ?? 60_000;
        const activityInterval = options.activityPollIntervalMs ?? 500;
        if (
            ![clickTimeout, arrivalTimeout, interval, activityTimeout, activityInterval].every(
                value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647,
            )
        ) {
            throw new TicketPlusSessionError(stage, "invalid-options");
        }

        // 以最新快照建立目標定位，再確認按鈕與場次身分仍然相同。
        reason = "read-failed";
        const started = performance.now();
        activityWait = { started, deadline: started + activityTimeout, observations: 0 };
        const target = await waitForActivitySession(
            page,
            settings,
            flowType,
            activityWait,
            activityInterval,
            clickTimeout,
            control,
            onDiagnostic,
        );
        const button = sessionButton(page, target, flowType);
        if (
            (await control.read(() => button.count())) !== 1 ||
            !(await control.read(() => button.isEnabled({ timeout: Math.min(clickTimeout, control.remainingMs()) })))
        ) {
            throw new TicketPlusSessionError(stage, "button-unavailable");
        }

        const latest = await waitForActivitySession(
            page,
            settings,
            flowType,
            activityWait,
            activityInterval,
            clickTimeout,
            control,
            onDiagnostic,
        );
        if (latest.name !== target.name || latest.date !== target.date || latest.time !== target.time) {
            throw new TicketPlusSessionError(stage, "session-changed");
        }

        // 最後一次核對（可能剛關閉提醒）之後再確認一次按鈕唯一且可用，不沿用關閉前的檢查。
        if (
            (await control.read(() => button.count())) !== 1 ||
            !(await control.read(() => button.isEnabled({ timeout: Math.min(clickTimeout, control.remainingMs()) })))
        ) {
            throw new TicketPlusSessionError(stage, "button-unavailable");
        }

        // 先記錄已嘗試，再呼叫一次 click。任何錯誤都不重按、不切換場次。
        control.check();
        reportActivityWait();
        stage = "after-click-attempt";
        reason = "click-failed";
        await button.click({ timeout: Math.min(clickTimeout, control.remainingMs()) });
        control.check();
        reason = "read-failed";
        diagnostic = undefined;
        return await waitForSelection(page, settings, arrivalTimeout, interval, control, onDiagnostic, latest);
    } catch (error) {
        reportActivityWait();
        control.check();
        if (error instanceof TicketPlusStopError) throw error;
        if (error instanceof TicketPlusSessionError) {
            error.diagnostic ??= diagnostic;
            throw error;
        }
        // 原始 Playwright 錯誤可能包含網址或 DOM，僅回傳固定階段與原因。
        throw new TicketPlusSessionError(stage, reason, diagnostic);
    }
}
