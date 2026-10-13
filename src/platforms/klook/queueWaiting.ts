import type { Page } from "playwright";
import { log } from "../../core/logger.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { reportState } from "../../core/state.js";
import { isEventPage } from "./eventPage.js";
import { findQueueControl } from "./queueControl.js";
import { isQueuePage, readQueueSnapshot } from "./queuePage.js";
import type { QueueSnapshot, QueueStage } from "./queuePage.js";

export interface QueueWaitingOptions {
    queueEnabled?: boolean;
    queueTimeout?: number;
    pageTimeout?: number;
    pollInterval?: number;
}

// 單次排隊等待的進度；跨網站刷新保留。
interface QueueWaitState {
    // 網站導頁次數；用來判斷讀取途中文件是否已換。
    documentVersion: number;
    // 已嘗試點擊的按鈕（點擊前就記錄）；嘗試過就不再按。
    joinAttempted: boolean;
    continueAttempted: boolean;
    // 已看到排隊中或放行，代表確實已入隊。
    joined: boolean;
    // 最近一次回報給畫面的階段，只在階段改變時回報。
    lastStage?: QueueStage;
    // 點擊後等待網站回應的期限；它比點擊後 unknownSince 的寬限早，通常由它先停止。
    pendingUntil?: number;
    // 順位保留期限，只能維持或縮短。
    admissionUntil?: number;
    // 畫面持續看不懂的起點；超過寬限就停止。
    unknownSince?: number;
}

interface QueueWaitContext {
    queueUrl: string;
    deadline: number;
    loadTimeout: number;
}

type QueueActionResult = "clicked" | "wait" | "unknown";

function isNavigationReadError(error: unknown): boolean {
    return (
        error instanceof Error &&
        /Execution context was destroyed|Cannot find context with specified id/.test(error.message)
    );
}

// 點擊後不再信任畫面，避免重按：
// 按過「繼續預訂」一律視為未知；已按排隊購票或已入隊後又看到倒數，也視為未知。
function effectiveStage(stage: QueueStage, state: QueueWaitState): QueueStage {
    if (state.continueAttempted) return "unknown";
    if ((state.joinAttempted || state.joined) && stage === "countdown") return "unknown";
    return stage;
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
        const context = { queueUrl, deadline, loadTimeout };
        const state: QueueWaitState = {
            documentVersion: 0,
            joinAttempted: false,
            continueAttempted: false,
            joined: false,
        };
        const onNavigation = () => {
            state.documentVersion++;
        };
        page.on("framenavigated", onNavigation);

        try {
            while (Date.now() < deadline) {
                // 只接受原排隊頁或原活動，返回後由啟動流程重新驗證
                if (page.isClosed()) throw new PurchaseStop("瀏覽器已關閉，排隊等待停止。");
                if (isEventPage(page.url(), this.eventUrl)) return;
                if (!isQueuePage(page.url(), this.eventUrl) || !isEventPage(page.url(), queueUrl)) {
                    throw new PurchaseStop("排隊途中到達非預期頁面，已停止。");
                }
                if (state.pendingUntil !== undefined && Date.now() >= state.pendingUntil) {
                    throw new PurchaseStop("排隊按鈕點擊結果未確認，已停止；不會重按。");
                }
                if (state.admissionUntil !== undefined && Date.now() >= state.admissionUntil) {
                    throw new PurchaseStop("順位保留已過期，已停止；不會重新入隊。");
                }

                // 網站導頁可能銷毀讀取中的文件，只重讀，不重做操作
                const version = state.documentVersion;
                const snapshot = await this.readCurrentSnapshot(state, version);
                let stage = effectiveStage(snapshot.stage, state);

                // 排隊與放行是入隊完成的證據；不要求觀察到每個百分比
                if (stage === "waiting" || stage === "admitted") {
                    state.joined = true;
                    state.pendingUntil = undefined;
                }
                if (stage === "admitted") {
                    state.admissionUntil = Math.min(
                        state.admissionUntil ?? Infinity,
                        Date.now() + snapshot.seconds! * 1000,
                    );
                }
                if (stage !== "unknown" && stage !== state.lastStage) {
                    reportState(stage === "countdown" ? "QUEUE_COUNTDOWN" : "WAITING_IN_QUEUE");
                    state.lastStage = stage;
                }

                // 動作前再核對當下文件及階段，先記錄嘗試再點擊
                const name =
                    stage === "admitted"
                        ? "繼續預訂"
                        : stage === "countdown" && snapshot.seconds === 0
                          ? "排隊購票"
                          : undefined;
                if (name) {
                    const result = await this.tryQueueAction(name, stage, version, context, state);
                    if (result === "unknown") stage = "unknown";
                }

                // 未知或重載中的畫面只給短暫寬限，不延長整體期限
                if (stage === "unknown") {
                    state.unknownSince ??= Date.now();
                    if (Date.now() - state.unknownSince >= loadTimeout) {
                        throw new PurchaseStop("排隊頁持續未知或回到入隊入口，已停止；不會重新入隊。");
                    }
                } else state.unknownSince = undefined;
                await page.waitForTimeout(
                    Math.max(0, Math.min(this.options.pollInterval ?? 500, deadline - Date.now())),
                );
            }
            throw new PurchaseStop("排隊已達等待上限，已停止；保留分頁，不自動重新排隊。");
        } finally {
            page.off("framenavigated", onNavigation);
        }
    }

    private async readCurrentSnapshot(state: QueueWaitState, version: number): Promise<QueueSnapshot> {
        try {
            const snapshot = await readQueueSnapshot(this.page, this.eventUrl);
            return version === state.documentVersion ? snapshot : { stage: "unknown" };
        } catch (error) {
            if (!isNavigationReadError(error)) throw error;
            return { stage: "unknown" };
        }
    }

    private async tryQueueAction(
        name: "排隊購票" | "繼續預訂",
        stage: QueueStage,
        version: number,
        context: QueueWaitContext,
        state: QueueWaitState,
    ): Promise<QueueActionResult> {
        try {
            // 找到控制項後，確認仍是本輪讀取的排隊頁
            const control = await findQueueControl(this.page, name);
            if (!control) return "unknown";
            if (version !== state.documentVersion || !isEventPage(this.page.url(), context.queueUrl)) {
                return "wait";
            }

            // 點擊前重讀狀態，刷新或倒數變動就留到下一輪
            const current = await readQueueSnapshot(this.page, this.eventUrl);
            if (current.stage !== stage || version !== state.documentVersion) return "wait";
            if (stage === "countdown" && current.seconds !== 0) return "wait";

            // 順位與操作期限只能維持或縮短
            if (stage === "admitted") {
                state.admissionUntil = Math.min(state.admissionUntil!, Date.now() + current.seconds! * 1000);
            }
            const actionDeadline = Math.min(
                context.deadline,
                Date.now() + context.loadTimeout,
                state.admissionUntil ?? Infinity,
            );
            if (Date.now() >= actionDeadline) throw new PurchaseStop("排隊操作期限已過，已停止。");

            // 先記錄嘗試再點擊，結果不明也不會重按
            if (name === "排隊購票") state.joinAttempted = true;
            else state.continueAttempted = true;
            state.pendingUntil = actionDeadline;
            log(`嘗試點擊「${name}」一次，等待網站回應。`);
            if (state.continueAttempted) reportState("QUEUE_CONTINUING");

            try {
                await control.click({ timeout: Math.max(1, actionDeadline - Date.now()), noWaitAfter: true });
            } catch {
                throw new PurchaseStop(`「${name}」點擊結果不明，已停止；不會重按。`);
            }
            return "clicked";
        } catch (error) {
            // 明確停止（包含點擊結果不明）一律往外拋
            if (error instanceof PurchaseStop) throw error;

            // 讀取途中網站導頁或刷新，下一輪重讀
            if (isNavigationReadError(error) || version !== state.documentVersion) return "unknown";

            // 其他錯誤不可忽略
            throw error;
        }
    }
}
