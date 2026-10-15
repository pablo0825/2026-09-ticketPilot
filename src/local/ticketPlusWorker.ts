import type { BrowserContext } from "playwright";
import type { TicketPlusActivitySettings } from "../config/ticketPlusActivity.js";
import type { PurchaseLease } from "../app/purchaseLock.js";
import { runTicketPlus } from "../app/runTicketPlus.js";
import { ticketPlusEventMessage, ticketPlusResultMessage } from "../app/ticketPlusPresentation.js";
import { emptySubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";
import { stoppedSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import type { PurchaseEvent } from "./purchaseEvents.js";
import { waitForTicketPlusWorkerLogin } from "./ticketPlusWorkerLogin.js";

export interface TicketPlusWorkerResult {
    outcome: "information-ready" | "failed" | "unknown";
    message: string;
}

export async function runTicketPlusWorker(
    activity: TicketPlusActivitySettings,
    lease: PurchaseLease,
    onBrowser: (context: BrowserContext) => void,
    sendEvent: (event: PurchaseEvent) => void,
    onSubmitAttempt: () => void,
    signal?: AbortSignal,
): Promise<TicketPlusWorkerResult> {
    // 提交標記先於通知保存；外圍錯誤不能把已嘗試提交改成未提交。
    let progress = emptySubmissionProgress();
    try {
        const result = await runTicketPlus(activity, {
            lease,
            signal,
            webdriverExperiment: process.env.WEBDRIVER_EXPERIMENT === "1",
            onBrowser,
            waitForLogin: (page, signal) =>
                waitForTicketPlusWorkerLogin(
                    page,
                    confirmationId => {
                        sendEvent({ type: "ticketplus", stage: "login-ready", confirmationId });
                    },
                    signal,
                ),
            onEvent: event => {
                if (event.type === "submission") {
                    progress = { ...event.progress };
                    if (progress.submitAttempted) onSubmitAttempt();
                }
                if (event.type === "stage") sendEvent({ type: "ticketplus", stage: event.stage });
                else if (event.type === "submission" && event.progress.sawQueue && !event.progress.failure) {
                    sendEvent({ type: "ticketplus", stage: "queue" });
                }
                const message = ticketPlusEventMessage(event);
                if (message) sendEvent({ type: "log", message });
            },
        });

        // 僅回傳安全摘要，資料頁物件與網站個資不進入 IPC 或執行紀錄。
        return {
            outcome:
                result.outcome === "information-ready"
                    ? "information-ready"
                    : result.outcome === "unknown"
                      ? "unknown"
                      : "failed",
            message: ticketPlusResultMessage(result),
        };
    } catch (error) {
        const result = stoppedSubmissionResult(error, progress);
        return {
            outcome: result.outcome === "unknown" ? "unknown" : "failed",
            message: ticketPlusResultMessage(result),
        };
    }
}
