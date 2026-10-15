import type { BrowserContext } from "playwright";
import type { TicketPlusActivitySettings } from "../config/ticketPlusActivity.js";
import type { PurchaseLease } from "../app/purchaseLock.js";
import { runTicketPlus } from "../app/runTicketPlus.js";
import { ticketPlusEventMessage, ticketPlusResultMessage } from "../app/ticketPlusPresentation.js";
import { emptySubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";
import { stoppedSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import type { PurchaseEvent } from "./purchaseEvents.js";

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
    let submissionAttempts = 0;
    try {
        const result = await runTicketPlus(activity, {
            lease,
            signal,
            webdriverExperiment: process.env.WEBDRIVER_EXPERIMENT === "1",
            onBrowser,
            onEvent: event => {
                if (event.type === "attempt-reset") {
                    progress = emptySubmissionProgress();
                    submissionAttempts = event.submissionAttempts;
                }
                if (event.type === "submission") {
                    if (event.progress.submitAttempted && !progress.submitAttempted) submissionAttempts++;
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
        const result = { ...stoppedSubmissionResult(error, progress), submissionAttempts };
        return {
            outcome: result.outcome === "unknown" ? "unknown" : "failed",
            message: ticketPlusResultMessage(result),
        };
    }
}
