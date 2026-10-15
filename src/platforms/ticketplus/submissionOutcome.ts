import type { TicketPlusStopReason } from "./runControl.js";
import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import type { Page } from "playwright";
import type { TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";
import type { InformationPage } from "./informationPage.js";
import { emptySubmissionProgress, submitTicketPlusSelection, TicketPlusSubmissionError } from "./ticketSubmission.js";
import type {
    SubmissionDiagnostic,
    SubmissionObserver,
    SubmissionProgress,
    SubmissionReason,
    TicketSubmissionOptions,
} from "./ticketSubmission.js";

interface ResultProgress {
    stopReason?: TicketPlusStopReason;
    progress: Readonly<SubmissionProgress>;
    diagnostic?: SubmissionDiagnostic;
}
export type TicketPlusSubmissionResult =
    | (ResultProgress & { outcome: "information-ready"; information: InformationPage })
    | (ResultProgress & { outcome: "rejected" | "unknown" | "stopped"; reason: SubmissionReason | "unexpected-error" });

// 明確失敗與關閉結果分開保存；未知例外也不能把已嘗試提交退回未提交。
export function stoppedSubmissionResult(
    error: unknown,
    observed = emptySubmissionProgress(),
): TicketPlusSubmissionResult {
    const reported = error instanceof TicketPlusSubmissionError ? error.progress : observed;
    const progress = Object.freeze({
        ...reported,
        submitAttempted: reported.submitAttempted || observed.submitAttempted,
        dismissAttempted: reported.dismissAttempted || observed.dismissAttempted,
        sawQueue: reported.sawQueue || observed.sawQueue,
        failure: reported.failure ?? observed.failure,
    });
    const outcome = progress.failure ? "rejected" : progress.submitAttempted ? "unknown" : "stopped";
    const reason =
        error instanceof TicketPlusSubmissionError
            ? error.reason
            : error instanceof TicketPlusStopError
              ? error.stopReason === "time-limit"
                  ? "time-limit"
                  : "user-stopped"
              : "unexpected-error";
    const stopReason =
        error instanceof TicketPlusSubmissionError
            ? error.stopReason
            : error instanceof TicketPlusStopError
              ? error.stopReason
              : undefined;
    return {
        outcome,
        reason,
        progress,
        ...(stopReason ? { stopReason } : {}),
        ...(error instanceof TicketPlusSubmissionError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    };
}

// runner 只接收終局結果；此層不做任何重試或錯誤恢復。
export async function runTicketPlusSubmission(
    page: Page,
    settings: TicketPlusSelection,
    selected: TicketSelectionPage,
    options: TicketSubmissionOptions = {},
    observer?: SubmissionObserver,
    control = new TicketPlusRunControl(),
): Promise<TicketPlusSubmissionResult> {
    let progress = emptySubmissionProgress();
    try {
        const information = await submitTicketPlusSelection(
            page,
            settings,
            selected,
            options,
            value => {
                // 先保存內部狀態，再通知外部；外部出錯仍有可靠的提交紀錄。
                progress = { ...value };
                return observer?.(Object.freeze({ ...value }));
            },
            control,
        );
        return { outcome: "information-ready", information, progress: Object.freeze({ ...progress }) };
    } catch (error) {
        return stoppedSubmissionResult(error, progress);
    }
}
