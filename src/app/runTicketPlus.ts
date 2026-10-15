import type { TicketPlusStopReason } from "../platforms/ticketplus/runControl.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../platforms/ticketplus/runControl.js";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { join } from "node:path";
import { projectRoot } from "../config/activityStore.js";
import {
    parseTicketPlusActivity,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
} from "../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../config/ticketPlusActivity.js";
import { acquirePurchaseLease, releasePurchaseLease, verifyPurchaseLease } from "./purchaseLock.js";
import type { PurchaseLease } from "./purchaseLock.js";
import type {
    SessionDiagnostic,
    SessionEntryReason,
    SessionEntryStage,
} from "../platforms/ticketplus/sessionSelection.js";
import { TicketPlusSessionError, selectTicketPlusSession } from "../platforms/ticketplus/sessionSelection.js";
import { TicketPlusPriorityError } from "../platforms/ticketplus/ticketPriority.js";
import { runTicketPlusCycle } from "../platforms/ticketplus/purchaseCycle.js";
import type {
    TicketPlusCycleEvent,
    TicketPlusCycleResult,
    TicketPlusCycleStage,
} from "../platforms/ticketplus/purchaseCycle.js";
import type { PriorityReason } from "../platforms/ticketplus/ticketPriority.js";
import { stoppedSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import type { TicketPlusSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import { emptySubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";
import { prepareTicketPlusSale, TicketPlusSaleError } from "../platforms/ticketplus/salePreparation.js";
import type { TicketPlusSaleReason } from "../platforms/ticketplus/salePreparation.js";
import type { SubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";

export type TicketPlusStage =
    | "starting"
    | "waiting-for-login"
    | "waiting-for-sale"
    | "refreshing-activity"
    | "waiting-for-availability"
    | "selecting-session"
    | TicketPlusCycleStage;
export type TicketPlusRunEvent =
    { type: "stage"; stage: TicketPlusStage } | TicketPlusCycleEvent | { type: "lease-release-failed" };
export type TicketPlusRunResult =
    | TicketPlusSubmissionResult
    | TicketPlusCycleResult
    | {
          outcome: "stopped";
          reason:
              | "startup-stopped"
              | "login-stopped"
              | "sale-wait-stopped"
              | "session-selection-stopped"
              | "ticket-selection-stopped";
          progress: Readonly<SubmissionProgress>;
          priorityFailure?: PriorityReason;
          saleFailure?: TicketPlusSaleReason;
          stopReason?: TicketPlusStopReason;
          sessionFailure?: { reason: SessionEntryReason; stage: SessionEntryStage; diagnostic?: SessionDiagnostic };
      };
export interface TicketPlusRunOptions {
    // 回呼必須合作取消並清理監聽，不能只讓外層提早返回。
    waitForLogin: (page: Page, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
    deadlineNow?: () => number;
    saleNow?: () => number;
    onEvent?: (event: TicketPlusRunEvent) => void | Promise<void>;
    onBrowser?: (context: BrowserContext) => void;
    lease?: PurchaseLease;
    webdriverExperiment?: boolean;
}

function notify(options: TicketPlusRunOptions, event: TicketPlusRunEvent): void {
    try {
        void Promise.resolve(options.onEvent?.(event)).catch(() => {});
    } catch {
        /* 通知不控制購票。 */
    }
}

export async function runTicketPlus(
    input: TicketPlusActivitySettings,
    options: TicketPlusRunOptions,
): Promise<TicketPlusRunResult> {
    // 所有啟動輸入先驗證，錯誤時不取得占用或開啟瀏覽器。
    const activity = parseTicketPlusActivity(input);
    const settings = ticketPlusSessionSelection(activity);
    validateTicketPlusRunSettings(activity);
    if (typeof options.waitForLogin !== "function") throw new Error("TicketPlus 需要人工登入交接。");
    const control = new TicketPlusRunControl(options.signal, options.deadlineNow);
    if (options.signal?.aborted && !options.lease) {
        return {
            outcome: "stopped",
            reason: "startup-stopped",
            stopReason: "user-stop",
            progress: Object.freeze(emptySubmissionProgress()),
        };
    }
    const lease = options.lease ?? acquirePurchaseLease();
    verifyPurchaseLease(lease);
    let settled = false;
    let browserClosed = true;
    let released = false;
    let stage: TicketPlusStage = "starting";
    let progress = emptySubmissionProgress();

    // 流程與瀏覽器皆結束才釋放；失敗也不自動關閉供人工檢查的畫面。
    const release = () => {
        if (!settled || !browserClosed || released) return;
        released = true;
        try {
            releasePurchaseLease(lease);
        } catch {
            notify(options, { type: "lease-release-failed" });
        }
    };
    const report = (value: TicketPlusStage) => {
        stage = value;
        notify(options, { type: "stage", stage });
    };
    try {
        report("starting");
        control.check();
        const context = await chromium.launchPersistentContext(join(projectRoot, "browser-profile-ticketplus"), {
            channel: "chrome",
            timeout: 30_000,
            headless: false,
            chromiumSandbox: true,
            args: options.webdriverExperiment ? ["--disable-blink-features=AutomationControlled"] : [],
        });
        browserClosed = false;
        context.once("close", () => {
            browserClosed = true;
            release();
        });
        options.onBrowser?.(context);
        control.check();
        // persistent context 應有初始分頁；缺頁時停止，避免重新開頁或留下無期限建立工作。
        const page = context.pages()[0];
        if (!page) throw new Error("購票瀏覽器沒有可用分頁。");
        control.check();
        const response = await page.goto(settings.eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        control.check();
        if (response && !response.ok()) throw new Error("活動頁無法載入。");

        // 登入由使用者操作；交接後仍由正式模組核對活動／場次，不相信舊畫面。
        report("waiting-for-login");
        control.check();
        await options.waitForLogin(page, options.signal);
        control.check();
        if (page.isClosed()) throw new Error("購票頁已關閉。");
        if (activity.saleSchedule) {
            report("waiting-for-sale");
            await prepareTicketPlusSale(page, settings, activity.saleSchedule, control, {
                now: options.saleNow,
                onStage: report,
            });
        }
        // 登入與開賣等待不消耗購票期限；之後各階段共用同一期限。
        control.startDeadline(activity.maxRunMinutes);
        report("selecting-session");
        const session = await selectTicketPlusSession(page, settings, {}, control);
        // 同輪候補由獨立模組編排；本次結果與歷史提交不混用。
        return await runTicketPlusCycle(page, activity, session, control, event => {
            if (event.type === "stage") stage = event.stage;
            if (event.type === "attempt-reset") progress = emptySubmissionProgress();
            if (event.type === "submission") progress = { ...event.progress };
            notify(options, event);
        });
    } catch (error) {
        let stopError = error instanceof TicketPlusStopError ? error : undefined;
        if (!stopError) {
            try {
                control.check();
            } catch (caught) {
                if (caught instanceof TicketPlusStopError) stopError = caught;
            }
        }
        if (stopError) {
            const result = stoppedSubmissionResult(stopError, progress);
            return result;
        }
        if (progress.submitAttempted || progress.failure) return stoppedSubmissionResult(error, progress);
        if ((stage as TicketPlusStage) === "selecting-session" && error instanceof TicketPlusSessionError) {
            return {
                outcome: "stopped",
                reason: "session-selection-stopped",
                sessionFailure: { reason: error.reason, stage: error.stage, diagnostic: error.diagnostic },
                progress: Object.freeze(emptySubmissionProgress()),
            };
        }
        if (error instanceof TicketPlusSaleError) {
            return {
                outcome: "stopped",
                reason: "sale-wait-stopped",
                saleFailure: error.reason,
                progress: Object.freeze(emptySubmissionProgress()),
            };
        }
        const reason =
            stage === "starting"
                ? "startup-stopped"
                : stage === "waiting-for-login"
                  ? "login-stopped"
                  : stage === "waiting-for-sale" ||
                      stage === "refreshing-activity" ||
                      stage === "waiting-for-availability"
                    ? "sale-wait-stopped"
                    : stage === "selecting-session"
                      ? "session-selection-stopped"
                      : "ticket-selection-stopped";
        return {
            outcome: "stopped",
            reason,
            progress: Object.freeze(emptySubmissionProgress()),
            ...(error instanceof TicketPlusPriorityError ? { priorityFailure: error.reason } : {}),
        };
    } finally {
        settled = true;
        release();
    }
}
