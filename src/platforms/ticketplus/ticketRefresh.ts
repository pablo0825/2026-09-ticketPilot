import type { Page } from "playwright";
import { readTicketPlusPage } from "./pageState.js";
import { validDate, validTime } from "./readResult.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl, TicketPlusStopReason } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type TicketRefreshReason =
    | "invalid-session"
    | "invalid-options"
    | "unexpected-page"
    | "identity-mismatch"
    | "remaining-quantity"
    | "button-unavailable"
    | "click-failed"
    | "operation-timeout"
    | "read-failed"
    | "completion-unverified"
    | "user-stopped"
    | "time-limit";

// 尚無經實站確認的完成訊號，因此本版沒有可放行下一輪的成功結果。
export interface TicketRefreshResult {
    kind: "stopped";
    reason: TicketRefreshReason;
    clickAttempted: boolean;
    stopReason?: TicketPlusStopReason;
}
export interface TicketRefreshOptions {
    timeoutMs?: number;
    clickTimeoutMs?: number;
}
class RefreshBlocked extends Error {
    constructor(readonly reason: TicketRefreshReason) {
        super(reason);
    }
}

// 單次更新操作；呼叫端決定何時需要更新，此處不判斷目標庫存也不重試。
export async function refreshTicketPlusTickets(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: TicketRefreshOptions = {},
): Promise<TicketRefreshResult> {
    let clickAttempted = false;
    const stopped = (reason: TicketRefreshReason): TicketRefreshResult => ({ kind: "stopped", reason, clickAttempted });
    try {
        // 保存期望場次並限制本次操作時間，沿用整趟停止控制。
        control.check();
        const identity = { ...session };
        if (
            Object.values(identity).some(value => typeof value !== "string" || !value.trim()) ||
            typeof identity.eventId !== "string" ||
            typeof identity.sessionId !== "string" ||
            !/^[A-Za-z0-9_-]+$/.test(identity.eventId) ||
            !/^[A-Za-z0-9_-]+$/.test(identity.sessionId) ||
            typeof identity.eventName !== "string" ||
            !identity.eventName.trim() ||
            !validDate(identity.date) ||
            !validTime(identity.time)
        ) {
            return stopped("invalid-session");
        }
        const timeout = options.timeoutMs ?? 5_000;
        const clickTimeout = options.clickTimeoutMs ?? 2_000;
        if (![timeout, clickTimeout].every(value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647)) {
            return stopped("invalid-options");
        }
        const deadline = performance.now() + timeout;
        const remaining = () => {
            control.check();
            const value = deadline - performance.now();
            if (value <= 0) throw new RefreshBlocked("operation-timeout");
            return Math.min(value, control.remainingMs());
        };
        const read = async <T>(operation: () => Promise<T>): Promise<T> => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const value = await control.read(() =>
                    Promise.race([
                        operation(),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => reject(new RefreshBlocked("operation-timeout")), remaining());
                        }),
                    ]),
                );
                remaining();
                return value;
            } finally {
                clearTimeout(timer);
            }
        };
        const verify = async () => {
            const snapshot = await read(() => readTicketPlusPage(page));
            if (snapshot.kind === "unknown" && snapshot.reason === "read-failed")
                throw new RefreshBlocked("read-failed");
            if (snapshot.kind !== "ticket-selection") throw new RefreshBlocked("unexpected-page");
            if (
                snapshot.eventId !== identity.eventId ||
                snapshot.sessionId !== identity.sessionId ||
                snapshot.eventName !== identity.eventName ||
                snapshot.date !== identity.date ||
                snapshot.time !== identity.time
            ) {
                throw new RefreshBlocked("identity-mismatch");
            }
            if (snapshot.tickets.some(ticket => ticket.selectedQuantity !== 0)) {
                throw new RefreshBlocked("remaining-quantity");
            }
        };

        // 核對全頁後固定唯一可見節點，避免等待時改點替換後的按鈕。
        await verify();
        const locator = page.getByRole("button", { name: "更新票數", exact: true }).filter({ visible: true });
        if ((await read(() => locator.count())) !== 1) return stopped("button-unavailable");
        const button = await locator.elementHandle({ timeout: Math.min(clickTimeout, remaining()) });
        if (!button) return stopped("button-unavailable");
        try {
            await verify();
            if (
                (await read(() => locator.count())) !== 1 ||
                !(await read(() => button.isVisible())) ||
                !(await read(() => button.isEnabled()))
            ) {
                return stopped("button-unavailable");
            }

            // 點擊有原生期限，嘗試後不補按，也不以外層取消留下晚到點擊。
            const limit = Math.min(clickTimeout, remaining());
            clickAttempted = true;
            try {
                await button.click({ timeout: limit });
            } catch {
                control.check();
                return stopped("click-failed");
            }
            remaining();
        } finally {
            await button.dispose().catch(() => {});
        }

        // 此讀取僅檢查異常，舊畫面仍完整不代表更新完成；不捏造等待或成功訊號。
        await verify();
        return stopped("completion-unverified");
    } catch (error) {
        let stop = error instanceof TicketPlusStopError ? error : undefined;
        try {
            control.check();
        } catch (caught) {
            if (caught instanceof TicketPlusStopError) stop = caught;
        }
        if (stop) {
            return {
                ...stopped(stop.stopReason === "time-limit" ? "time-limit" : "user-stopped"),
                stopReason: stop.stopReason,
            };
        }
        return stopped(error instanceof RefreshBlocked ? error.reason : "read-failed");
    }
}
