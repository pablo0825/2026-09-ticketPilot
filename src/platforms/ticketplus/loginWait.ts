import type { Page } from "playwright";
import { TicketPlusStopError } from "./runControl.js";
import { readTicketPlusLoginState } from "./loginState.js";
import type { TicketPlusLoginObservation } from "./loginState.js";

export interface TicketPlusLoginSummary {
    elapsedMs: number;
    observations: number;
    lastObservation?: TicketPlusLoginObservation;
}
export type TicketPlusLoginReason =
    | "page-timeout"
    | "login-timeout"
    | "sale-expired"
    | "page-closed"
    | "page-crashed"
    | "read-timeout"
    | "read-failed"
    | "unexpected-route"
    | "menu-failed";
export class TicketPlusLoginError extends Error {
    constructor(
        readonly reason: TicketPlusLoginReason,
        readonly summary: TicketPlusLoginSummary,
    ) {
        super(`TicketPlus 登入確認停止（${reason}）。`);
        this.name = "TicketPlusLoginError";
    }
}
export interface TicketPlusLoginOptions {
    signal?: AbortSignal;
    onObservation?: (observation: TicketPlusLoginObservation, summary: TicketPlusLoginSummary) => void;
    onWaiting?: () => void;
    onStopped?: (summary: TicketPlusLoginSummary) => void | Promise<void>;
    pageTimeoutMs?: number;
    loginTimeoutMs?: number;
    readTimeoutMs?: number;
    pollIntervalMs?: number;
    deadline?: number;
    now?: () => number;
}

export async function waitForTicketPlusLogin(
    page: Page,
    options: TicketPlusLoginOptions = {},
): Promise<TicketPlusLoginSummary> {
    // 等待期限與購票期限分開，人工登入期限只在第一次明確未登入時啟動。
    const pageTimeout = options.pageTimeoutMs ?? 30_000;
    const loginTimeout = options.loginTimeoutMs ?? 300_000;
    const readTimeout = options.readTimeoutMs ?? 5_000;
    const interval = options.pollIntervalMs ?? 250;
    if (
        ![pageTimeout, loginTimeout, readTimeout, interval].every(value => Number.isFinite(value) && value > 0) ||
        (options.deadline !== undefined && !Number.isFinite(options.deadline))
    ) {
        throw new Error("登入等待時間設定無效。");
    }
    const now = options.now ?? Date.now;
    const started = performance.now();
    let phaseDeadline = started + pageTimeout;
    const saleBudget = options.deadline === undefined ? Infinity : options.deadline - now();
    const saleDeadline = started + saleBudget;
    let waiting = false;
    let menuAttempted = false;
    let crashed = false;
    let observations = 0;
    let lastObservation: TicketPlusLoginObservation | undefined;
    const summary = (): TicketPlusLoginSummary => ({
        elapsedMs: Math.round(performance.now() - started),
        observations,
        ...(lastObservation ? { lastObservation } : {}),
    });
    const fail = (reason: TicketPlusLoginReason): never => {
        throw new TicketPlusLoginError(reason, summary());
    };
    const remaining = () => {
        if (options.signal?.aborted) throw new TicketPlusStopError();
        if (crashed) return fail("page-crashed");
        if (page.isClosed()) return fail("page-closed");
        const saleRemaining = Math.min(
            saleDeadline - performance.now(),
            options.deadline === undefined ? Infinity : options.deadline - now(),
        );
        if (Number.isNaN(saleRemaining)) return fail("read-failed");
        if (saleRemaining <= 0) return fail("sale-expired");
        const phaseRemaining = phaseDeadline - performance.now();
        if (phaseRemaining <= 0) return fail(waiting ? "login-timeout" : "page-timeout");
        return Math.min(phaseRemaining, saleRemaining);
    };
    const onCrash = () => {
        crashed = true;
    };
    page.on("crash", onCrash);

    // 唯讀擷取可被取消；頁面仍在收尾時也不會由晚到結果觸發後續導覽。
    const boundedRead = async (): Promise<TicketPlusLoginObservation> => {
        remaining();
        const readDeadline = performance.now() + readTimeout;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let interrupt = () => {};
        try {
            const stopped = new Promise<never>((_, reject) => {
                interrupt = () => {
                    try {
                        remaining();
                    } catch (error) {
                        reject(error);
                    }
                };
                options.signal?.addEventListener("abort", interrupt, { once: true });
                page.once("close", interrupt);
                page.once("crash", interrupt);
                const watchDeadline = () => {
                    try {
                        const overallRemaining = remaining();
                        const readRemaining = readDeadline - performance.now();
                        if (readRemaining <= 0) fail("read-timeout");
                        timer = setTimeout(
                            watchDeadline,
                            Math.max(1, Math.ceil(Math.min(overallRemaining, readRemaining))),
                        );
                    } catch (error) {
                        reject(error);
                    }
                };
                watchDeadline();
                interrupt();
            });
            const result = await Promise.race([readTicketPlusLoginState(page), stopped]);
            remaining();
            if (performance.now() >= readDeadline) fail("read-timeout");
            return result;
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", interrupt);
            page.off("close", interrupt);
            page.off("crash", interrupt);
        }
    };
    const pause = async () => {
        const budget = Math.min(interval, remaining());
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake = () => {};
        try {
            await new Promise<void>(resolve => {
                wake = resolve;
                timer = setTimeout(resolve, budget);
                options.signal?.addEventListener("abort", wake, { once: true });
                page.once("close", wake);
                page.once("crash", wake);
                if (options.signal?.aborted || page.isClosed() || crashed) resolve();
            });
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", wake);
            page.off("close", wake);
            page.off("crash", wake);
        }
        remaining();
    };

    // 只在首頁觀測會員區；必要時展開一次窄版選單，不操作登入表單。
    try {
        while (true) {
            remaining();
            lastObservation = await boundedRead();
            observations++;
            options.onObservation?.(lastObservation, summary());
            remaining();
            if (lastObservation.reason === "unexpected-route" || lastObservation.routeKind !== "home")
                fail("unexpected-route");
            if (lastObservation.reason === "page-closed") fail("page-closed");
            if (lastObservation.reason === "read-failed") fail("read-failed");
            if (lastObservation.state === "logged-in") return summary();
            if (lastObservation.state === "logged-out" && !waiting) {
                waiting = true;
                phaseDeadline = performance.now() + loginTimeout;
                options.onWaiting?.();
            }
            if (
                !menuAttempted &&
                lastObservation.state === "unknown" &&
                lastObservation.reason === "incomplete" &&
                lastObservation.markers.menuButtons === 1 &&
                lastObservation.markers.openDrawers === 0 &&
                lastObservation.markers.dialogs === 0
            ) {
                menuAttempted = true;
                remaining();
                if (page.url() !== "https://ticketplus.com.tw/") fail("unexpected-route");
                try {
                    // 選單只做同步命中後點擊，不讓 actionability 等待在取消後補點。
                    const opened = await page.evaluate(() => {
                        const dom = {
                            visible(element: Element): boolean {
                                const rect = element.getBoundingClientRect();
                                const style = getComputedStyle(element);
                                return (
                                    rect.width > 0 &&
                                    rect.height > 0 &&
                                    rect.bottom > 0 &&
                                    rect.right > 0 &&
                                    rect.top < innerHeight &&
                                    rect.left < innerWidth &&
                                    style.display !== "none" &&
                                    style.visibility !== "hidden" &&
                                    !element.closest('.v-navigation-drawer--close, [hidden], [aria-hidden="true"]')
                                );
                            },
                        };
                        if (location.origin !== "https://ticketplus.com.tw" || location.pathname !== "/") return false;
                        const headers = [...document.querySelectorAll("header.headerApp")].filter(dom.visible);
                        if (headers.length !== 1) return false;
                        const dialogs = [
                            ...document.querySelectorAll('.v-dialog__content--active, [role="dialog"]'),
                        ].filter(dom.visible);
                        const drawers = [...document.querySelectorAll("nav.v-navigation-drawer")].filter(dom.visible);
                        if (dialogs.length > 0 || drawers.length > 0) return false;
                        const buttons = [
                            ...headers[0]!.querySelectorAll("button.mdi-menu, button:has(.mdi-menu)"),
                        ].filter(dom.visible);
                        if (buttons.length !== 1) return false;
                        const button = buttons[0]!;
                        if (
                            !(button instanceof HTMLButtonElement) ||
                            button.disabled ||
                            button.getAttribute("aria-disabled") === "true"
                        ) {
                            return false;
                        }
                        const rect = button.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                        if (!hit || !button.contains(hit)) return false;
                        button.click();
                        return true;
                    });
                    remaining();
                    if (!opened) fail("menu-failed");
                } catch {
                    remaining();
                    fail("menu-failed");
                }
                remaining();
            }
            await pause();
        }
    } catch (error) {
        // 停止診斷只保存已有觀測，不重讀頁面，也不能改變原本的停止原因。
        try {
            void Promise.resolve(options.onStopped?.(structuredClone(summary()))).catch(() => {});
        } catch {
            /* 診斷通知失敗不影響流程。 */
        }
        throw error;
    } finally {
        page.off("crash", onCrash);
    }
}
