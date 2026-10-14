import type { Locator, Page } from "playwright";
import { parseTicketPlusActivity } from "../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../../config/ticketPlusActivity.js";
import type { ActivityPage } from "./activityPage.js";
import { readTicketPlusPage } from "./pageState.js";
import type { TicketPlusPage } from "./pageState.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";

type Session = ActivityPage["sessions"][number];
export type SessionEntryStage = "before-click" | "after-click-attempt";
export type SessionEntryReason =
    | "invalid-settings"
    | "invalid-options"
    | "unexpected-page"
    | "activity-mismatch"
    | "session-missing"
    | "session-ambiguous"
    | "session-disabled"
    | "session-changed"
    | "button-unavailable"
    | "click-failed"
    | "arrival-mismatch"
    | "arrival-timeout"
    | "read-failed";

export class TicketPlusSessionError extends Error {
    constructor(
        public readonly stage: SessionEntryStage,
        public readonly reason: SessionEntryReason,
    ) {
        super(
            stage === "before-click"
                ? `TicketPlus 場次選擇停止（${reason}），尚未嘗試點擊。`
                : `TicketPlus 已嘗試進入場次（${reason}），請人工確認；不會重新點擊。`,
        );
        this.name = "TicketPlusSessionError";
    }
}

export interface SessionSelectionOptions {
    clickTimeoutMs?: number;
    arrivalTimeoutMs?: number;
    pollIntervalMs?: number;
}

function requireTargetSession(snapshot: TicketPlusPage, settings: TicketPlusActivitySettings): Session {
    // 先核對活動身分，再以日期與時間找唯一場次。
    if (snapshot.kind !== "activity") throw new TicketPlusSessionError("before-click", "unexpected-page");
    const eventId = new URL(settings.eventUrl).pathname.split("/")[2];
    if (snapshot.eventId !== eventId || snapshot.eventName !== settings.eventName) {
        throw new TicketPlusSessionError("before-click", "activity-mismatch");
    }
    const matches = snapshot.sessions.filter(
        session => session.date === settings.target.date && session.time === settings.target.time,
    );
    if (matches.length === 0) throw new TicketPlusSessionError("before-click", "session-missing");
    if (matches.length !== 1) throw new TicketPlusSessionError("before-click", "session-ambiguous");

    // 停用列也參與唯一性檢查，不能先排除它來消除歧義。
    const session = matches[0]!;
    if (!session.buyEnabled) throw new TicketPlusSessionError("before-click", "session-disabled");
    return session;
}

function exactText(value: string): RegExp {
    return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
}

function sessionButton(page: Page, settings: TicketPlusActivitySettings, session: Session): Locator {
    // 定位條件隨 DOM 重新解析，不保存列表索引，也不使用整列模糊文字。
    const body = page
        .locator("body")
        .filter({ has: page.getByRole("heading", { level: 1, name: settings.eventName, exact: true }) });
    const date = new RegExp(`^\\s*${session.date}(?:\\([一二三四五六日]\\))?\\s*$`);
    const row = body
        .locator(".sesstion-item")
        .filter({ visible: true })
        .filter({
            has: page
                .locator(".font-weight-bold.is-word-break")
                .filter({ visible: true, hasText: exactText(session.name) }),
        })
        .filter({ has: page.getByText(date).filter({ visible: true }) })
        .filter({ has: page.getByText(exactText(session.time)).filter({ visible: true }) });
    return row.getByRole("button", { name: "立即購買", exact: true }).filter({ visible: true });
}

function expectedArrivalRoute(page: Page, settings: TicketPlusActivitySettings): boolean {
    const current = new URL(page.url());
    const expected = new URL(settings.eventUrl);
    if (current.origin !== expected.origin || current.search || current.hash || current.username || current.password) {
        return false;
    }
    const eventId = expected.pathname.split("/")[2]!;
    return (
        current.pathname.replace(/\/$/, "") === expected.pathname.replace(/\/$/, "") ||
        new RegExp(`^/order/${eventId}/[A-Za-z0-9_-]+/?$`).test(current.pathname)
    );
}

// 逾時後可能仍有唯讀 evaluate 收尾，但不會繼續點擊或變更頁面。
async function readWithinDeadline(page: Page, timeout: number, stage: SessionEntryStage): Promise<TicketPlusPage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            readTicketPlusPage(page),
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
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function waitForSelection(
    page: Page,
    settings: TicketPlusActivitySettings,
    timeout: number,
    interval: number,
): Promise<TicketSelectionPage> {
    // 只設一次期限，暫時缺資料不會延長等待，也不會回到點擊流程。
    const deadline = performance.now() + timeout;
    const eventId = new URL(settings.eventUrl).pathname.split("/")[2];
    while (performance.now() < deadline) {
        if (page.isClosed()) throw new TicketPlusSessionError("after-click-attempt", "read-failed");
        if (!expectedArrivalRoute(page, settings)) {
            throw new TicketPlusSessionError("after-click-attempt", "unexpected-page");
        }
        const snapshot = await readWithinDeadline(page, deadline - performance.now(), "after-click-attempt");
        if (performance.now() >= deadline) break;

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
        if (snapshot.kind === "activity") {
            if (snapshot.eventId !== eventId || snapshot.eventName !== settings.eventName) {
                throw new TicketPlusSessionError("after-click-attempt", "activity-mismatch");
            }
        } else if (
            snapshot.kind !== "unknown" ||
            !["incomplete-data", "page-changed", "read-failed"].includes(snapshot.reason)
        ) {
            throw new TicketPlusSessionError("after-click-attempt", "unexpected-page");
        }

        // 等待期間不刷新、不處理排隊，也不碰選票頁的任何控制項。
        await new Promise(resolve =>
            setTimeout(resolve, Math.min(interval, Math.max(0, deadline - performance.now()))),
        );
    }
    throw new TicketPlusSessionError("after-click-attempt", "arrival-timeout");
}

// 前提是使用者已手動登入並停在活動頁。單次呼叫最多一次 click；跨呼叫防重複由未來 runner 負責。
export async function selectTicketPlusSession(
    page: Page,
    input: TicketPlusActivitySettings,
    options: SessionSelectionOptions = {},
): Promise<TicketSelectionPage> {
    let stage: SessionEntryStage = "before-click";
    let reason: SessionEntryReason = "invalid-settings";
    try {
        // 複製並驗證設定，操作途中不受呼叫端修改設定影響。
        const settings = parseTicketPlusActivity(input);
        const clickTimeout = options.clickTimeoutMs ?? 5_000;
        const arrivalTimeout = options.arrivalTimeoutMs ?? 15_000;
        const interval = options.pollIntervalMs ?? 100;
        if (
            ![clickTimeout, arrivalTimeout, interval].every(
                value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647,
            )
        ) {
            throw new TicketPlusSessionError(stage, "invalid-options");
        }

        // 以最新快照建立目標定位，再確認按鈕與場次身分仍然相同。
        reason = "read-failed";
        const target = requireTargetSession(await readWithinDeadline(page, clickTimeout, stage), settings);
        const button = sessionButton(page, settings, target);
        if ((await button.count()) !== 1 || !(await button.isEnabled({ timeout: clickTimeout }))) {
            throw new TicketPlusSessionError(stage, "button-unavailable");
        }
        const latest = requireTargetSession(await readWithinDeadline(page, clickTimeout, stage), settings);
        if (latest.name !== target.name || latest.date !== target.date || latest.time !== target.time) {
            throw new TicketPlusSessionError(stage, "session-changed");
        }

        // 先記錄已嘗試，再呼叫一次 click。任何錯誤都不重按、不切換場次。
        stage = "after-click-attempt";
        reason = "click-failed";
        await button.click({ timeout: clickTimeout });
        reason = "read-failed";
        return await waitForSelection(page, settings, arrivalTimeout, interval);
    } catch (error) {
        if (error instanceof TicketPlusSessionError) throw error;
        // 原始 Playwright 錯誤可能包含網址或 DOM，僅回傳固定階段與原因。
        throw new TicketPlusSessionError(stage, reason);
    }
}
