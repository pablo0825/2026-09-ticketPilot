import type { TicketPlusLoginReason, TicketPlusLoginSummary } from "../platforms/ticketplus/loginWait.js";
import { waitForTicketPlusLogin, TicketPlusLoginError } from "../platforms/ticketplus/loginWait.js";
import { readTicketPlusLoginState } from "../platforms/ticketplus/loginState.js";
import type { TicketPlusStopReason } from "../platforms/ticketplus/runControl.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../platforms/ticketplus/runControl.js";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { join } from "node:path";
import { projectRoot } from "../config/activityStore.js";
import {
    parseTicketPlusActivity,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
    ticketPlusFlowType,
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
import { dismissTicketPlusActivityNotice, TicketPlusNoticeError } from "../platforms/ticketplus/activityNotice.js";
import { readTicketPlusPage } from "../platforms/ticketplus/pageState.js";
import { TicketPlusPriorityError } from "../platforms/ticketplus/ticketPriority.js";
import { runTicketPlusCycle } from "../platforms/ticketplus/purchaseCycle.js";
import { finishTicketPlusLottery } from "./ticketPlusLottery.js";
import type { TicketPlusLotteryResult } from "./ticketPlusLottery.js";
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
    | "checking-login"
    | "opening-activity"
    | "waiting-for-login"
    | "waiting-for-sale"
    | "refreshing-activity"
    | "waiting-for-availability"
    | "selecting-session"
    | "waiting-for-participants"
    | "completing-registration"
    | TicketPlusCycleStage;
export type TicketPlusRunEvent =
    | { type: "stage"; stage: TicketPlusStage }
    | { type: "login-observation"; summary: TicketPlusLoginSummary }
    | { type: "login-stopped"; summary: TicketPlusLoginSummary }
    | { type: "login-wait"; elapsedMs: number; observations: number }
    | { type: "activity-wait"; elapsedMs: number; observations: number }
    | TicketPlusCycleEvent
    | { type: "participants-wait"; confirmationId: string }
    | { type: "lease-release-failed" };
export type TicketPlusRunResult = (
    | TicketPlusSubmissionResult
    | TicketPlusCycleResult
    | TicketPlusLotteryResult
    | {
          outcome: "stopped";
          reason:
              | "startup-stopped"
              | "login-stopped"
              | "sale-wait-stopped"
              | "session-selection-stopped"
              | "ticket-selection-stopped";
          progress: Readonly<SubmissionProgress>;
          loginFailure?: { reason: TicketPlusLoginReason; summary: TicketPlusLoginSummary };
          priorityFailure?: PriorityReason;
          saleFailure?: TicketPlusSaleReason;
          stopReason?: TicketPlusStopReason;
          sessionFailure?: { reason: SessionEntryReason; stage: SessionEntryStage; diagnostic?: SessionDiagnostic };
          noticeFailure?: "notice-dismiss-failed";
      }
) & { loginDiagnostic?: TicketPlusLoginSummary };
export interface TicketPlusRunOptions {
    signal?: AbortSignal;
    deadlineNow?: () => number;
    saleNow?: () => number;
    onEvent?: (event: TicketPlusRunEvent) => void | Promise<void>;
    onBrowser?: (context: BrowserContext) => void;
    lease?: PurchaseLease;
    webdriverExperiment?: boolean;
    // 抽選在輸入資料頁等待 GUI 確認參加者已填完；未提供時抽選停在資料頁（information-ready）。
    waitForParticipants?: (confirmationId: string) => Promise<void>;
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
    let loginDiagnostic: TicketPlusLoginSummary | undefined;
    let lastLoginFingerprint: string | undefined;

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
        const response = await page.goto("https://ticketplus.com.tw/", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        control.check();
        if (response && !response.ok()) throw new Error("首頁無法載入。");

        // 首頁只觀察會員區；登入成功後才導覽一次目標活動。
        report("checking-login");
        const login = await waitForTicketPlusLogin(page, {
            signal: options.signal,
            deadline: activity.saleSchedule ? Date.parse(activity.saleSchedule.saleAt) + 120_000 : undefined,
            now: options.saleNow,
            onWaiting: () => report("waiting-for-login"),
            onObservation: (observation, summary) => {
                const fingerprint = JSON.stringify(observation);
                if (fingerprint === lastLoginFingerprint) return;
                lastLoginFingerprint = fingerprint;
                notify(options, { type: "login-observation", summary: structuredClone(summary) });
            },
            onStopped: summary => {
                loginDiagnostic = summary;
                notify(options, { type: "login-stopped", summary: structuredClone(summary) });
            },
        });
        notify(options, { type: "login-wait", elapsedMs: login.elapsedMs, observations: login.observations });
        control.check();
        if (page.isClosed()) throw new Error("購票頁已關閉。");
        report("opening-activity");
        control.check();
        const targetResponse = await page.goto(settings.eventUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        control.check();
        if (targetResponse && !targetResponse.ok()) throw new Error("活動頁無法載入。");
        // 開啟活動頁後若已顯示已知提醒就先關閉；其他狀態交給後續登入與場次核對。
        let openingReadTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const opening = await control.read(() =>
                Promise.race([
                    readTicketPlusPage(page),
                    new Promise<undefined>(resolve => {
                        openingReadTimer = setTimeout(() => resolve(undefined), 5_000);
                    }),
                ]),
            );
            control.check();
            if (opening?.kind === "unknown" && opening.reason === "notice-dialog") {
                await dismissTicketPlusActivityNotice(page, control);
            }
        } finally {
            clearTimeout(openingReadTimer);
        }
        let loginReadTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            const targetLogin = await control.read(() =>
                Promise.race([
                    readTicketPlusLoginState(page, { allowActivity: true }),
                    new Promise<never>((_, reject) => {
                        loginReadTimer = setTimeout(() => reject(new Error("活動頁登入核對逾時。")), 5_000);
                    }),
                ]),
            );
            control.check();
            if (
                targetLogin.state === "logged-out" ||
                ["unexpected-route", "read-failed", "page-closed"].includes(targetLogin.reason)
            ) {
                throw new Error("活動頁登入無法確認。");
            }
        } finally {
            clearTimeout(loginReadTimer);
        }
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
        const session = await selectTicketPlusSession(
            page,
            settings,
            {
                flowType: ticketPlusFlowType(activity),
                onActivityWait: summary => notify(options, { type: "activity-wait", ...summary }),
            },
            control,
        );
        // 同場次候補與更新後循環由獨立模組編排；本次結果與歷史提交不混用。
        const cycle = await runTicketPlusCycle(page, activity, session, control, event => {
            if (event.type === "stage") stage = event.stage;
            if (event.type === "attempt-reset") progress = emptySubmissionProgress();
            if (event.type === "submission") progress = { ...event.progress };
            notify(options, event);
        });

        // 抽選到輸入資料頁：等待人工確認參加者後收尾，停在確認登記前。
        if (
            cycle.outcome !== "information-ready" ||
            ticketPlusFlowType(activity) !== "lottery" ||
            !options.waitForParticipants ||
            cycle.submittedQuantity === undefined
        ) {
            return cycle;
        }
        const waitForParticipants = options.waitForParticipants;
        return await finishTicketPlusLottery(
            page,
            session,
            cycle.submittedQuantity,
            control,
            {
                waitForParticipants,
                onWaiting: confirmationId => {
                    report("waiting-for-participants");
                    notify(options, { type: "participants-wait", confirmationId });
                },
                onCompleting: () => report("completing-registration"),
            },
            { submissionAttempts: cycle.submissionAttempts, progress: cycle.progress },
        );
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
            return { ...result, ...(loginDiagnostic ? { loginDiagnostic } : {}) };
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
            stage === "starting" || stage === "opening-activity"
                ? "startup-stopped"
                : ["checking-login", "waiting-for-login"].includes(stage)
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
            ...(loginDiagnostic ? { loginDiagnostic } : {}),
            ...(error instanceof TicketPlusLoginError
                ? { loginFailure: { reason: error.reason, summary: error.summary } }
                : {}),
            ...(error instanceof TicketPlusPriorityError ? { priorityFailure: error.reason } : {}),
            ...(error instanceof TicketPlusNoticeError ? { noticeFailure: error.reason } : {}),
        };
    } finally {
        settled = true;
        release();
    }
}
