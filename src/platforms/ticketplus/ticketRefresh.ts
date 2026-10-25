import type { Page } from "playwright";
import { readTicketPlusDom } from "./domSnapshot.js";
import type { RefreshMonitorRequest } from "./domSnapshot.js";
import { randomUUID } from "node:crypto";
import { readTicketPlusPage, readTicketPlusRefreshObservation } from "./pageState.js";
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

export type TicketRefreshResult =
    | {
          kind: "completed";
          clickAttempted: true;
          reason?: never;
          stopReason?: never;
      }
    | {
          kind: "stopped";
          reason: TicketRefreshReason;
          clickAttempted: boolean;
          stopReason?: TicketPlusStopReason;
      };
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
    let waitingForRefresh = false;
    let monitor: RefreshMonitorRequest | undefined;
    const stopped = (reason: TicketRefreshReason): Extract<TicketRefreshResult, { kind: "stopped" }> => ({
        kind: "stopped",
        reason,
        clickAttempted,
    });
    try {
        // 保存期望場次並限制本次操作時間，沿用整趟停止控制。
        control.check();
        const identity = { ...session };
        if (
            [identity.eventId, identity.sessionId, identity.eventName, identity.date, identity.time].some(
                value => typeof value !== "string" || !value.trim(),
            )
        ) {
            return stopped("invalid-session");
        }

        if (typeof identity.eventId !== "string" || typeof identity.sessionId !== "string") {
            return stopped("invalid-session");
        }

        if (!/^[A-Za-z0-9_-]+$/.test(identity.eventId) || !/^[A-Za-z0-9_-]+$/.test(identity.sessionId)) {
            return stopped("invalid-session");
        }

        if (typeof identity.eventName !== "string" || !identity.eventName.trim()) {
            return stopped("invalid-session");
        }

        if (!validDate(identity.date) || !validTime(identity.time)) {
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

            // 安裝直接等待收尾，不放入唯讀取消競賽；到期安裝會自行拒絕。
            monitor = { token: randomUUID(), action: "install", expiresAt: Date.now() + remaining() };
            await readTicketPlusDom(page, monitor);
            remaining();

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

        // 輪詢只決定等待與完成；完整舊畫面沒有本次過渡證據仍不能放行。
        waitingForRefresh = true;
        while (performance.now() < deadline) {
            const observation = await read(() =>
                readTicketPlusRefreshObservation(page, identity, { ...monitor!, action: "read" }),
            );
            if (observation.readiness.status === "stop") {
                return stopped(observation.readiness.reason as TicketRefreshReason);
            }
            if (observation.readiness.status === "ready") {
                remaining();
                return { kind: "completed", clickAttempted: true };
            }
            const wait = Math.min(50, remaining());
            await control.wait(wait);
            if (performance.now() >= deadline) return stopped("completion-unverified");
        }
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
        if (waitingForRefresh && error instanceof RefreshBlocked && error.reason === "operation-timeout") {
            return stopped("completion-unverified");
        }
        return stopped(error instanceof RefreshBlocked ? error.reason : "read-failed");
    } finally {
        if (monitor) {
            await page
                .locator("html")
                .evaluate(
                    (_element, token) => {
                        const host = window as unknown as { ticketPilotRefresh?: { token: string; dispose(): void } };
                        if (host.ticketPilotRefresh?.token === token) host.ticketPilotRefresh.dispose();
                    },
                    monitor.token,
                    { timeout: 500 },
                )
                .catch(() => {});
        }
    }
}
