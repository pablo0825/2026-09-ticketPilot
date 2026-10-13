import type { Page } from "playwright";
import { log } from "../../core/logger.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { reportState } from "../../core/state.js";
import { isEventPage } from "./eventPage.js";
import { findQueueControl } from "./queueControl.js";
import { isQueuePage, readQueueSnapshot } from "./queuePage.js";
import type { QueueSnapshot } from "./queuePage.js";

export interface QueueWaitingOptions {
    queueEnabled?: boolean;
    queueTimeout?: number;
    pageTimeout?: number;
    pollInterval?: number;
}

function isNavigationReadError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /Execution context was destroyed|Cannot find context with specified id/.test(error.message)
    );
}

// 每次啟動只建立一個實例；網站刷新不重設入隊、繼續預訂或等待期限。
export class KlookQueueWaiting {
    private handled = false;

    constructor(
        private readonly page: Page,
        private readonly eventUrl: string,
        private readonly options: QueueWaitingOptions,
    ) {}

    get hasEntered(): boolean {
        return this.handled;
    }

    async handleIfPresent(): Promise<boolean> {
        if (!this.options.queueEnabled || !isQueuePage(this.page.url(), this.eventUrl)) return false;
        if (this.handled) throw new PurchaseStop("放行後再次進入排隊頁，已停止；不會重新入隊。");
        this.handled = true;
        log("已啟用排隊流程；等待網站放行，最多一小時，不主動刷新或離隊。");
        try {
            await this.wait();
            return true;
        } catch (error) {
            if (error instanceof PurchaseStop) log(error.message);
            throw error;
        }
    }

    private async wait(): Promise<void> {
        // 固定整體期限與原排隊頁身分
        const page = this.page;
        const deadline = Date.now() + (this.options.queueTimeout ?? 3_600_000);
        const loadTimeout = this.options.pageTimeout ?? 30_000;
        const queueUrl = page.url();
        let documentVersion = 0;
        const onNavigation = () => {
            documentVersion++;
        };
        page.on("framenavigated", onNavigation);

        // 點擊紀錄與順位期限跨網站刷新保留
        let joinAttempted = false;
        let continueAttempted = false;
        let joined = false;
        let pendingUntil: number | undefined;
        let admissionUntil: number | undefined;
        let unknownSince: number | undefined;
        let lastStage: string | undefined;

        try {
            while (Date.now() < deadline) {
                // 只接受原排隊頁或原活動，返回後由啟動流程重新驗證
                if (page.isClosed()) throw new PurchaseStop("瀏覽器已關閉，排隊等待停止。");
                if (isEventPage(page.url(), this.eventUrl)) return;
                if (!isQueuePage(page.url(), this.eventUrl) || !isEventPage(page.url(), queueUrl)) {
                    throw new PurchaseStop("排隊途中到達非預期頁面，已停止。");
                }
                if (pendingUntil !== undefined && Date.now() >= pendingUntil) {
                    throw new PurchaseStop("排隊按鈕點擊結果未確認，已停止；不會重按。");
                }
                if (admissionUntil !== undefined && Date.now() >= admissionUntil) {
                    throw new PurchaseStop("順位保留已過期，已停止；不會重新入隊。");
                }

                // 網站導頁可能銷毀讀取中的文件，只重讀，不重做操作
                const version = documentVersion;
                let snapshot: QueueSnapshot = { stage: "unknown" };
                try {
                    snapshot = await readQueueSnapshot(page, this.eventUrl);
                } catch (error) {
                    if (!isNavigationReadError(error)) throw error;
                }
                if (version !== documentVersion) snapshot = { stage: "unknown" };
                let stage = snapshot.stage;
                if (continueAttempted || ((joinAttempted || joined) && stage === "countdown")) stage = "unknown";

                // 排隊與放行是入隊完成的證據；不要求觀察到每個百分比
                if (stage === "waiting" || stage === "admitted") {
                    joined = true;
                    pendingUntil = undefined;
                }
                if (stage === "admitted") {
                    admissionUntil = Math.min(admissionUntil ?? Infinity, Date.now() + snapshot.seconds! * 1000);
                }
                if (stage !== "unknown" && stage !== lastStage) {
                    reportState(stage === "countdown" ? "QUEUE_COUNTDOWN" : "WAITING_IN_QUEUE");
                    lastStage = stage;
                }

                // 動作前再核對當下文件及階段，先記錄嘗試再點擊
                const name =
                    stage === "admitted"
                        ? "繼續預訂"
                        : stage === "countdown" && snapshot.seconds === 0
                          ? "排隊購票"
                          : undefined;
                if (name) {
                    try {
                        const control = await findQueueControl(page, name);
                        if (!control) stage = "unknown";
                        if (control && version === documentVersion && isEventPage(page.url(), queueUrl)) {
                            const current = await readQueueSnapshot(page, this.eventUrl);
                            if (
                                current.stage === stage &&
                                version === documentVersion &&
                                (stage !== "countdown" || current.seconds === 0)
                            ) {
                                if (stage === "admitted") {
                                    admissionUntil = Math.min(admissionUntil!, Date.now() + current.seconds! * 1000);
                                }
                                const actionDeadline = Math.min(
                                    deadline,
                                    Date.now() + loadTimeout,
                                    admissionUntil ?? Infinity,
                                );
                                if (Date.now() >= actionDeadline) throw new PurchaseStop("排隊操作期限已過，已停止。");
                                if (name === "排隊購票") joinAttempted = true;
                                else continueAttempted = true;
                                pendingUntil = actionDeadline;
                                log(`嘗試點擊「${name}」一次，等待網站回應。`);
                                if (continueAttempted) reportState("QUEUE_CONTINUING");
                                try {
                                    await control.click({
                                        timeout: Math.max(1, actionDeadline - Date.now()),
                                        noWaitAfter: true,
                                    });
                                } catch {
                                    throw new PurchaseStop(`「${name}」點擊結果不明，已停止；不會重按。`);
                                }
                            }
                        }
                    } catch (error) {
                        if (
                            error instanceof PurchaseStop ||
                            (!isNavigationReadError(error) && version === documentVersion)
                        )
                            throw error;
                        stage = "unknown";
                    }
                }

                // 未知或重載中的畫面只給短暫寬限，不延長整體期限
                if (stage === "unknown") {
                    unknownSince ??= Date.now();
                    if (Date.now() - unknownSince >= loadTimeout) {
                        throw new PurchaseStop("排隊頁持續未知或回到入隊入口，已停止；不會重新入隊。");
                    }
                } else unknownSince = undefined;
                await page.waitForTimeout(
                    Math.max(0, Math.min(this.options.pollInterval ?? 500, deadline - Date.now())),
                );
            }
            throw new PurchaseStop("排隊已達等待上限，已停止；保留分頁，不自動重新排隊。");
        } finally {
            page.off("framenavigated", onNavigation);
        }
    }
}
