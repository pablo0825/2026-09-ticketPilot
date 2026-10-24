import type { BrowserContext } from "playwright";
import type { TicketPlusActivitySettings } from "../config/ticketPlusActivity.js";
import type { PurchaseLease } from "../app/purchaseLock.js";
import { runTicketPlus } from "../app/runTicketPlus.js";
import {
    ticketPlusEventMessage,
    ticketPlusResultDiagnostic,
    ticketPlusResultMessage,
} from "../app/ticketPlusPresentation.js";
import { emptySubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";
import { stoppedSubmissionResult } from "../platforms/ticketplus/submissionOutcome.js";
import type { TicketPlusStopReason } from "../platforms/ticketplus/runControl.js";
import type { WorkerPurchaseEvent } from "../shared/runEvents.js";

export interface TicketPlusWorkerResult {
    outcome: "information-ready" | "payment-ready" | "registration-ready" | "failed" | "unknown";
    message: string;
    stopReason?: TicketPlusStopReason;
}

export async function runTicketPlusWorker(
    activity: TicketPlusActivitySettings,
    lease: PurchaseLease,
    onBrowser: (context: BrowserContext) => void,
    sendEvent: (event: WorkerPurchaseEvent) => void,
    onSubmitAttempt: () => void,
    signal?: AbortSignal,
    waitForParticipants?: (confirmationId: string) => Promise<void>,
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
            waitForParticipants,
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
                // 等待參加者的階段由帶確認 ID 的事件回報，避免送出缺 ID 的同名階段。
                if (event.type === "participants-wait") {
                    sendEvent({
                        type: "ticketplus",
                        stage: "waiting-for-participants",
                        confirmationId: event.confirmationId,
                    });
                } else if (event.type === "stage" && event.stage !== "waiting-for-participants") {
                    sendEvent({ type: "ticketplus", stage: event.stage });
                } else if (event.type === "submission" && event.progress.sawQueue && !event.progress.failure) {
                    sendEvent({ type: "ticketplus", stage: "queue" });
                }
                const message = ticketPlusEventMessage(event);
                if (message) sendEvent({ type: "log", message });
            },
        });

        // 診斷先寫進開發者紀錄，結果訊息只留給使用者看的說明。
        sendDiagnostic(result, sendEvent);

        // 僅回傳安全摘要，資料頁物件與網站個資不進入 IPC 或執行紀錄。
        return {
            outcome:
                result.outcome === "information-ready"
                    ? "information-ready"
                    : result.outcome === "payment-ready"
                      ? "payment-ready"
                      : result.outcome === "registration-ready"
                        ? "registration-ready"
                        : result.outcome === "unknown"
                          ? "unknown"
                          : "failed",
            message: ticketPlusResultMessage(result),
            ...stopReasonOf(result),
        };
    } catch (error) {
        const result = { ...stoppedSubmissionResult(error, progress), submissionAttempts };
        sendDiagnostic(result, sendEvent);
        return {
            outcome: result.outcome === "unknown" ? "unknown" : "failed",
            message: ticketPlusResultMessage(result),
            ...stopReasonOf(result),
        };
    }
}

function sendDiagnostic(
    result: Parameters<typeof ticketPlusResultDiagnostic>[0],
    sendEvent: (event: WorkerPurchaseEvent) => void,
): void {
    const diagnostic = ticketPlusResultDiagnostic(result);
    if (diagnostic) sendEvent({ type: "log", message: diagnostic });
}

// 只帶出使用者停止或時間上限；沒有停止原因時不加欄位。
function stopReasonOf(result: object): { stopReason?: TicketPlusStopReason } {
    return "stopReason" in result && (result.stopReason === "user-stop" || result.stopReason === "time-limit")
        ? { stopReason: result.stopReason }
        : {};
}
