import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import type { ElementHandle, Page } from "playwright";
import { parseTicketPlusSelection } from "../../config/platforms/ticketplus/activitySettings.js";
import type { TicketPlusSelection } from "../../config/platforms/ticketplus/activitySettings.js";
import { readTicketPlusPage } from "./pageState.js";
import { findTargetTickets } from "./ticketSelectionPage.js";
import type { TicketRow, TicketSelectionPage } from "./ticketSelectionPage.js";
import { locateTargetRow } from "./ticketRowFinder.js";

export type VerifiedTicketPlusSession = Pick<
    TicketSelectionPage,
    "eventId" | "sessionId" | "eventName" | "date" | "time"
>;
export type QuantityStage = "before-click" | "after-click-attempt";
export type QuantityReason =
    | "invalid-settings"
    | "invalid-session"
    | "invalid-options"
    | "unexpected-page"
    | "identity-mismatch"
    | "ticket-missing"
    | "ticket-ambiguous"
    | "ticket-sold-out"
    | "ticket-unavailable"
    | "extra-tickets"
    | "button-unavailable"
    | "quantity-changed"
    | "click-failed"
    | "change-timeout"
    | "operation-timeout"
    | "read-failed";

export class TicketPlusQuantityError extends Error {
    constructor(
        public readonly stage: QuantityStage,
        public readonly reason: QuantityReason,
        // 最後確認的數值不是目前張數的保證，延遲更新仍可能發生。
        public readonly lastVerifiedQuantity: number | undefined,
        public readonly attemptedClicks: number,
    ) {
        super(
            stage === "before-click"
                ? `TicketPlus 選票停止（${reason}），尚未嘗試調整張數。`
                : `TicketPlus 已嘗試調整張數（${reason}），請人工確認現況；不會補按或還原。`,
        );
        this.name = "TicketPlusQuantityError";
    }
}

export interface TicketQuantityOptions {
    timeoutMs?: number;
    requireZeroInitialQuantity?: boolean;
    clickTimeoutMs?: number;
    changeTimeoutMs?: number;
    pollIntervalMs?: number;
}

interface Adjustment {
    control: TicketPlusRunControl;
    settings: TicketPlusSelection;
    identity: VerifiedTicketPlusSession;
    deadline: number;
    attemptedClicks: number;
    lastVerifiedQuantity?: number;
}

function stop(context: Adjustment, reason: QuantityReason): TicketPlusQuantityError {
    return new TicketPlusQuantityError(
        context.attemptedClicks === 0 ? "before-click" : "after-click-attempt",
        reason,
        context.lastVerifiedQuantity,
        context.attemptedClicks,
    );
}

function localRemaining(context: Adjustment, deadline = context.deadline): number {
    context.control.check();
    const now = performance.now();
    if (now >= context.deadline) throw stop(context, "operation-timeout");
    if (now >= deadline) throw stop(context, "change-timeout");
    return Math.min(context.deadline, deadline) - now;
}

function remaining(context: Adjustment, deadline = context.deadline): number {
    return Math.min(localRemaining(context, deadline), context.control.remainingMs());
}

// 僅包裝唯讀查詢；不能用此方式中止 click，避免逾時後仍產生點擊。
async function readBeforeDeadline<T>(context: Adjustment, deadline: number, read: () => Promise<T>): Promise<T> {
    const timeout = localRemaining(context, deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await context.control.read(() =>
            Promise.race([
                read(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                stop(context, context.deadline <= deadline ? "operation-timeout" : "change-timeout"),
                            ),
                        timeout,
                    );
                }),
            ]),
        );
        remaining(context, deadline);
        return result;
    } finally {
        clearTimeout(timer);
    }
}

async function readSelection(
    page: Page,
    context: Adjustment,
    deadline = context.deadline,
): Promise<{ snapshot: TicketSelectionPage; ticket: TicketRow }> {
    // 唯讀取樣也受期限限制，逾時後不再啟動任何操作。
    const snapshot = await readBeforeDeadline(context, deadline, () => readTicketPlusPage(page));
    if (snapshot.kind !== "ticket-selection") throw stop(context, "unexpected-page");

    // 上一階段的身分只作比對基準；本次張數一律來自最新完整快照。
    const expected = context.identity;
    if (
        snapshot.eventId !== expected.eventId ||
        snapshot.sessionId !== expected.sessionId ||
        snapshot.eventName !== expected.eventName ||
        snapshot.date !== expected.date ||
        snapshot.time !== expected.time
    ) {
        throw stop(context, "identity-mismatch");
    }
    const matches = findTargetTickets(snapshot.tickets, context.settings.target.ticketType);
    if (matches.length === 0) throw stop(context, "ticket-missing");
    if (matches.length !== 1) throw stop(context, "ticket-ambiguous");

    // 不替使用者清掉其他票種，也不把按鈕停用或未知庫存當售完。
    const ticket = matches[0]!;
    if (snapshot.tickets.some(other => other !== ticket && other.selectedQuantity !== 0)) {
        throw stop(context, "extra-tickets");
    }
    if (ticket.saleStatus === "sold-out") throw stop(context, "ticket-sold-out");
    // 暫無票券（他人保留中）不是售完，但目前不能購買，不點加減。
    if (ticket.saleStatus === "unavailable") throw stop(context, "ticket-unavailable");
    return { snapshot, ticket };
}

async function quantityButton(
    page: Page,
    name: string,
    count: number,
    direction: number,
): Promise<ElementHandle<Element> | null> {
    // 與讀取共用找列規則：票名完全相等、目前張數相符的唯一列，其計數器內唯一的加或減按鈕。
    const located = await page.evaluateHandle(locateTargetRow, { ticketType: name, quantity: count });
    try {
        const button = await located.getProperty(direction === 1 ? "plus" : "minus");
        const element = button.asElement();
        if (!element) await button.dispose();
        return element;
    } finally {
        await located.dispose();
    }
}

async function waitForChange(
    page: Page,
    context: Adjustment,
    expected: number,
    timeout: number,
    interval: number,
): Promise<void> {
    // 原值尚未變可短暫等待；跳值、其他票種變動、缺資料或換頁均停止。
    const deadline = Math.min(context.deadline, performance.now() + timeout);
    while (true) {
        const { ticket } = await readSelection(page, context, deadline);
        if (ticket.selectedQuantity === expected) {
            context.lastVerifiedQuantity = expected;
            return;
        }
        if (ticket.selectedQuantity !== context.lastVerifiedQuantity) throw stop(context, "quantity-changed");
        await context.control.wait(Math.min(interval, remaining(context, deadline)));
    }
}

function copyIdentity(settings: TicketPlusSelection, value: VerifiedTicketPlusSession): VerifiedTicketPlusSession {
    const identity = {
        eventId: value.eventId,
        sessionId: value.sessionId,
        eventName: value.eventName,
        date: value.date,
        time: value.time,
    };
    if (
        identity.eventId !== new URL(settings.eventUrl).pathname.split("/")[2] ||
        identity.eventName !== settings.eventName ||
        identity.date !== settings.target.date ||
        identity.time !== settings.target.time
    ) {
        throw new TicketPlusQuantityError("before-click", "invalid-session", undefined, 0);
    }

    if (typeof identity.sessionId !== "string") {
        throw new TicketPlusQuantityError("before-click", "invalid-session", undefined, 0);
    }

    if (!/^[A-Za-z0-9_-]+$/.test(identity.sessionId)) {
        throw new TicketPlusQuantityError("before-click", "invalid-session", undefined, 0);
    }

    return identity;
}

// 僅調整單一票種；不按下一步或更新票數、不切換候補、不恢復、不保證跨呼叫去重。
export async function selectTicketPlusTickets(
    page: Page,
    input: TicketPlusSelection,
    verifiedSession: VerifiedTicketPlusSession,
    options: TicketQuantityOptions = {},
    control = new TicketPlusRunControl(),
): Promise<TicketSelectionPage> {
    let context: Adjustment | undefined;
    let reason: QuantityReason = "invalid-settings";
    try {
        // 驗證並複製輸入，整段調整共用一個不重設的期限。
        control.check();
        const settings = parseTicketPlusSelection(input);
        reason = "invalid-session";
        const identity = copyIdentity(settings, verifiedSession);
        reason = "invalid-options";
        const timeout = options.timeoutMs ?? 30_000;
        const clickTimeout = options.clickTimeoutMs ?? 3_000;
        const changeTimeout = options.changeTimeoutMs ?? 3_000;
        const interval = options.pollIntervalMs ?? 100;
        if (
            ![timeout, clickTimeout, changeTimeout, interval].every(
                value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647,
            )
        ) {
            throw new TicketPlusQuantityError("before-click", "invalid-options", undefined, 0);
        }
        context = { control, settings, identity, deadline: performance.now() + timeout, attemptedClicks: 0 };
        reason = "read-failed";
        const initial = await readSelection(page, context);
        if (options.requireZeroInitialQuantity && initial.ticket.selectedQuantity !== 0) {
            throw stop(context, "quantity-changed");
        }
        context.lastVerifiedQuantity = initial.ticket.selectedQuantity;
        const difference = settings.target.quantity - initial.ticket.selectedQuantity;
        const direction = Math.sign(difference);
        const maxClicks = Math.abs(difference);

        // 初始差額固定次數與方向，途中不重新規劃或反向補救。
        for (let step = 0; step < maxClicks; step++) {
            const current = await readSelection(page, context);
            if (current.ticket.selectedQuantity !== context.lastVerifiedQuantity) {
                throw stop(context, "quantity-changed");
            }
            const canClick = direction === 1 ? current.ticket.canIncrease : current.ticket.canDecrease;
            if (!canClick) throw stop(context, "button-unavailable");
            const button = await readBeforeDeadline(context, context.deadline, () =>
                quantityButton(page, settings.target.ticketType, context!.lastVerifiedQuantity!, direction),
            );
            if (!button) throw stop(context, "button-unavailable");
            try {
                if (!(await readBeforeDeadline(context, context.deadline, () => button.isEnabled()))) {
                    throw stop(context, "button-unavailable");
                }
                const latest = await readSelection(page, context);
                if (latest.ticket.selectedQuantity !== context.lastVerifiedQuantity) {
                    throw stop(context, "quantity-changed");
                }
                if (!(direction === 1 ? latest.ticket.canIncrease : latest.ticket.canDecrease)) {
                    throw stop(context, "button-unavailable");
                }

                // 點擊前再定位一次，必須仍是同一顆按鈕；畫面重繪換了節點或列就停止，不改點新節點。
                const again = await readBeforeDeadline(context, context.deadline, () =>
                    quantityButton(page, settings.target.ticketType, context!.lastVerifiedQuantity!, direction),
                );
                try {
                    const same =
                        again !== null &&
                        (await readBeforeDeadline(context, context.deadline, () =>
                            button.evaluate((node, other) => node === other, again),
                        ));
                    if (!same) throw stop(context, "button-unavailable");
                } finally {
                    await again?.dispose().catch(() => {});
                }

                // 先計入嘗試次數，click 拋錯也不再重按；只有精確一張的變化可接續。
                const expected = context.lastVerifiedQuantity! + direction;
                const actionTimeout = Math.min(clickTimeout, remaining(context));
                context.attemptedClicks++;
                reason = "click-failed";
                await button.click({ timeout: actionTimeout });
                reason = "read-failed";
                await waitForChange(page, context, expected, changeTimeout, interval);
            } finally {
                await button.dispose().catch(() => {});
            }
        }

        // 目標原已達成也要重新核對全頁；下一步狀態只讀取，不操作。
        const final = await readSelection(page, context);
        if (final.ticket.selectedQuantity !== settings.target.quantity) throw stop(context, "quantity-changed");
        return final.snapshot;
    } catch (error) {
        control.check();
        if (error instanceof TicketPlusStopError) throw error;
        if (error instanceof TicketPlusQuantityError) throw error;
        if (context) throw stop(context, reason);
        throw new TicketPlusQuantityError("before-click", reason, undefined, 0);
    }
}
