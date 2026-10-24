import { errors } from "playwright";
import type { Page } from "playwright";
import type { TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { SaleSchedule } from "../../core/saleSchedule.js";
import { validateSaleSchedule } from "../../core/saleSchedule.js";
import { dismissTicketPlusActivityNotice, TicketPlusNoticeError } from "./activityNotice.js";
import { readTicketPlusActivityObservation } from "./pageState.js";
import type { TicketPlusPage } from "./pageState.js";
import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";

export type TicketPlusSaleReason =
    | "invalid-schedule"
    | "invalid-clock"
    | "sale-expired"
    | "page-closed"
    | "unexpected-page"
    | "activity-mismatch"
    | "session-missing"
    | "session-ambiguous"
    | "session-disabled"
    | "page-unrecognized"
    | "read-timeout"
    | "refresh-failed"
    | "notice-dismiss-failed";

export class TicketPlusSaleError extends Error {
    constructor(readonly reason: TicketPlusSaleReason) {
        super(`TicketPlus 開賣準備停止（${reason}）。`);
        this.name = "TicketPlusSaleError";
    }
}

export interface SalePreparationOptions {
    now?: () => number;
    onStage?: (stage: "waiting-for-sale" | "refreshing-activity" | "waiting-for-availability") => void;
}

export async function prepareTicketPlusSale(
    page: Page,
    settings: TicketPlusSelection,
    schedule: SaleSchedule,
    control: TicketPlusRunControl,
    options: SalePreparationOptions = {},
): Promise<void> {
    // 排程只驗證一次，日曆截止時間另以單調時鐘限制，避免調時延長等待。
    let saleAt: number;
    try {
        saleAt = validateSaleSchedule(schedule);
    } catch {
        throw new TicketPlusSaleError("invalid-schedule");
    }
    const now = options.now ?? Date.now;
    const calendarNow = () => {
        const value = now();
        if (!Number.isFinite(value)) throw new TicketPlusSaleError("invalid-clock");
        return value;
    };
    const cutoff = saleAt + 120_000;
    const deadline = performance.now() + Math.max(0, cutoff - calendarNow());
    const refreshAt = saleAt - (schedule.advanceSeconds ?? 1) * 1000;
    let crashed = false;
    const onCrash = () => {
        crashed = true;
    };
    page.on("crash", onCrash);

    const remaining = () => {
        control.check();
        if (page.isClosed() || crashed) throw new TicketPlusSaleError("page-closed");
        const value = Math.min(cutoff - calendarNow(), deadline - performance.now(), control.remainingMs());
        if (value <= 0) throw new TicketPlusSaleError("sale-expired");
        return value;
    };
    const requireActivityUrl = () => {
        remaining();
        if (page.url().replace(/\/$/, "") !== settings.eventUrl.replace(/\/$/, "")) {
            throw new TicketPlusSaleError("unexpected-page");
        }
    };
    const pause = async (milliseconds: number) => {
        await control.wait(Math.max(1, Math.min(250, milliseconds, remaining())));
        remaining();
    };

    // 關閉已知提醒；每次載入的點擊額度由關閉模組記在頁面上，同一次載入再出現就停止。
    const dismissNotice = async () => {
        try {
            await dismissTicketPlusActivityNotice(page, control, { timeoutMs: Math.min(5_000, remaining()) });
        } catch (error) {
            if (error instanceof TicketPlusNoticeError) throw new TicketPlusSaleError("notice-dismiss-failed");
            throw error;
        }
    };

    // 唯讀快照有獨立上限；空白只短暫等待，不視為尚未開賣。
    const readReady = async (): Promise<"available" | "not-on-sale"> => {
        let readDeadline = performance.now() + Math.min(5_000, remaining());
        while (true) {
            requireActivityUrl();
            const timeout = Math.min(readDeadline - performance.now(), remaining());
            if (timeout <= 0) throw new TicketPlusSaleError("read-timeout");
            let timer: ReturnType<typeof setTimeout> | undefined;
            let snapshot: TicketPlusPage;
            try {
                snapshot = await control.read(() =>
                    Promise.race([
                        readTicketPlusActivityObservation(page, {
                            eventId: new URL(settings.eventUrl).pathname.split("/")[2]!,
                            eventName: settings.eventName,
                        }).then(observation => observation.page),
                        new Promise<never>((_, reject) => {
                            timer = setTimeout(() => reject(new TicketPlusSaleError("read-timeout")), timeout);
                        }),
                    ]),
                );
            } finally {
                clearTimeout(timer);
            }
            requireActivityUrl();
            if (performance.now() >= readDeadline) throw new TicketPlusSaleError("read-timeout");
            if (snapshot.kind === "unknown" && snapshot.reason === "incomplete-data") {
                await pause(readDeadline - performance.now());
                continue;
            }
            if (snapshot.kind === "unknown" && snapshot.reason === "notice-dialog") {
                await dismissNotice();
                readDeadline = performance.now() + Math.min(5_000, remaining());
                continue;
            }
            if (snapshot.kind !== "activity") throw new TicketPlusSaleError("page-unrecognized");
            if (
                snapshot.eventName !== settings.eventName ||
                snapshot.eventId !== new URL(settings.eventUrl).pathname.split("/")[2]
            ) {
                throw new TicketPlusSaleError("activity-mismatch");
            }
            const matches = snapshot.sessions.filter(
                session => session.date === settings.target.date && session.time === settings.target.time,
            );
            if (matches.length === 0) throw new TicketPlusSaleError("session-missing");
            if (matches.length !== 1) throw new TicketPlusSaleError("session-ambiguous");
            if (matches[0]!.saleState === "disabled") throw new TicketPlusSaleError("session-disabled");
            return matches[0]!.saleState;
        }
    };

    // 每次開賣判斷都在讀取前後核對日曆時間，時鐘回撥時只等待。
    const readAfterSale = async (): Promise<"available" | "not-on-sale"> => {
        while (true) {
            if (calendarNow() < saleAt) {
                options.onStage?.("waiting-for-sale");
                while (calendarNow() < saleAt) await pause(saleAt - calendarNow());
            }
            const state = await readReady();
            remaining();
            if (calendarNow() >= saleAt) return state;
            await pause(saleAt - calendarNow());
        }
    };

    try {
        // 首次刷新等待指定提前時間，已到時間則立即刷新一次。
        requireActivityUrl();
        options.onStage?.("waiting-for-sale");
        while (calendarNow() < refreshAt) await pause(refreshAt - calendarNow());
        while (true) {
            requireActivityUrl();
            options.onStage?.("refreshing-activity");
            const refreshedAt = performance.now();
            const refreshBudget = Math.min(15_000, remaining());
            try {
                const response = await page.reload({
                    waitUntil: "domcontentloaded",
                    timeout: Math.max(1, refreshBudget),
                });
                remaining();
                if (!response?.ok()) throw new TicketPlusSaleError("refresh-failed");
            } catch (error) {
                remaining();
                if (error instanceof TicketPlusStopError || error instanceof TicketPlusSaleError) throw error;
                if (error instanceof errors.TimeoutError && refreshBudget < 15_000) {
                    throw new TicketPlusSaleError("sale-expired");
                }
                throw new TicketPlusSaleError("refresh-failed");
            }
            await readReady();

            // 開賣前即使按鈕可用也不入場；到點重新讀取，才接受可購買狀態。
            let state = await readAfterSale();
            if (state === "available") return;
            options.onStage?.("waiting-for-availability");
            while (performance.now() - refreshedAt < 3_000) {
                await pause(3_000 - (performance.now() - refreshedAt));
            }
            // 刷新前重新核對，頁面自行開賣或變更時不沿用舊的尚未開賣快照。
            state = await readAfterSale();
            if (state === "available") return;
        }
    } finally {
        page.off("crash", onCrash);
    }
}
