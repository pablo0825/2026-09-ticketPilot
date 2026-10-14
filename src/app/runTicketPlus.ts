import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { join } from "node:path";
import { projectRoot } from "../config/activityStore.js";
import { parseTicketPlusActivity, ticketPlusSessionSelection } from "../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../config/ticketPlusActivity.js";
import { acquirePurchaseLease, releasePurchaseLease, verifyPurchaseLease } from "./purchaseLock.js";
import type { PurchaseLease } from "./purchaseLock.js";
import type { SessionEntryReason, SessionEntryStage } from "../platforms/ticketplus/sessionSelection.js";
import { TicketPlusSessionError, selectTicketPlusSession } from "../platforms/ticketplus/sessionSelection.js";
import { selectTicketPlusPriority, TicketPlusPriorityError } from "../platforms/ticketplus/ticketPriority.js";
import type { PriorityReason } from "../platforms/ticketplus/ticketPriority.js";
import { runTicketPlusSubmission, stoppedSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import type { TicketPlusSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import { emptySubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";
import type { SubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";

export type TicketPlusStage =
    "starting" | "waiting-for-login" | "selecting-session" | "selecting-tickets" | "submitting";
export type TicketPlusRunEvent =
    | { type: "stage"; stage: TicketPlusStage }
    | { type: "submission"; progress: Readonly<SubmissionProgress> }
    | { type: "lease-release-failed" };
export type TicketPlusRunResult =
    | TicketPlusSubmissionResult
    | {
          outcome: "stopped";
          reason: "startup-stopped" | "login-stopped" | "session-selection-stopped" | "ticket-selection-stopped";
          progress: Readonly<SubmissionProgress>;
          priorityFailure?: PriorityReason;
          sessionFailure?: { reason: SessionEntryReason; stage: SessionEntryStage };
      };
export interface TicketPlusRunOptions {
    waitForLogin: (page: Page) => Promise<void>;
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
    if (typeof options.waitForLogin !== "function") throw new Error("TicketPlus 需要人工登入交接。");
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
        const context = await chromium.launchPersistentContext(join(projectRoot, "browser-profile-ticketplus"), {
            channel: "chrome",
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
        const page = context.pages()[0] ?? (await context.newPage());
        const response = await page.goto(settings.eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (response && !response.ok()) throw new Error("活動頁無法載入。");

        // 登入由使用者操作；交接後仍由正式模組核對活動／場次，不相信舊畫面。
        report("waiting-for-login");
        await options.waitForLogin(page);
        if (page.isClosed()) throw new Error("購票頁已關閉。");
        report("selecting-session");
        const session = await selectTicketPlusSession(page, settings);
        report("selecting-tickets");
        const selected = await selectTicketPlusPriority(page, activity, session);

        // 唯一一次提交在單向流程最後；資料頁是本階段終點，不處理條款或付款。
        report("submitting");
        return await runTicketPlusSubmission(page, selected.selection, selected.snapshot, {}, observed => {
            progress = { ...observed };
            notify(options, { type: "submission", progress: Object.freeze({ ...progress }) });
        });
    } catch (error) {
        if (progress.submitAttempted || progress.failure) return stoppedSubmissionResult(error, progress);
        if ((stage as TicketPlusStage) === "selecting-session" && error instanceof TicketPlusSessionError) {
            return {
                outcome: "stopped",
                reason: "session-selection-stopped",
                sessionFailure: { reason: error.reason, stage: error.stage },
                progress: Object.freeze(emptySubmissionProgress()),
            };
        }
        const reason =
            stage === "starting"
                ? "startup-stopped"
                : stage === "waiting-for-login"
                  ? "login-stopped"
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
