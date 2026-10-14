import type { Page } from "playwright";
import type { TicketPlusActivitySettings } from "../../config/ticketPlusActivity.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";
import type { InformationPage } from "./informationPage.js";
import { emptySubmissionProgress, submitTicketPlusSelection, TicketPlusSubmissionError } from "./ticketSubmission.js";
import type {
    SubmissionObserver,
    SubmissionProgress,
    SubmissionReason,
    TicketSubmissionOptions,
} from "./ticketSubmission.js";

interface ResultProgress {
    progress: Readonly<SubmissionProgress>;
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
    const reason = error instanceof TicketPlusSubmissionError ? error.reason : "unexpected-error";
    return { outcome, reason, progress };
}

// runner 只接收終局結果；此層不做任何重試或錯誤恢復。
export async function runTicketPlusSubmission(
    page: Page,
    settings: TicketPlusActivitySettings,
    selected: TicketSelectionPage,
    options: TicketSubmissionOptions = {},
    observer?: SubmissionObserver,
): Promise<TicketPlusSubmissionResult> {
    let progress = emptySubmissionProgress();
    try {
        const information = await submitTicketPlusSelection(page, settings, selected, options, value => {
            // 先保存內部狀態，再通知外部；外部出錯仍有可靠的提交紀錄。
            progress = { ...value };
            return observer?.(Object.freeze({ ...value }));
        });
        return { outcome: "information-ready", information, progress: Object.freeze({ ...progress }) };
    } catch (error) {
        return stoppedSubmissionResult(error, progress);
    }
}
