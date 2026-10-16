import type { Page } from "playwright";
import { parseTicketPlusActivity, ticketPlusSessionSelection } from "../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../../config/ticketPlusActivity.js";
import { inspectTicketPlusReselection } from "./reselectionReadiness.js";
import type { ReselectionBlockedReason } from "./reselectionReadiness.js";
import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import { runTicketPlusSubmission, stoppedSubmissionResult } from "./submissionOutcome.js";
import type { TicketPlusSubmissionResult } from "./submissionOutcome.js";
import { selectTicketPlusPriority, TicketPlusPriorityError } from "./ticketPriority.js";
import type { PriorityReason, TicketPriorityOptions } from "./ticketPriority.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";
import { refreshTicketPlusTickets } from "./ticketRefresh.js";
import type { TicketRefreshOptions, TicketRefreshResult } from "./ticketRefresh.js";
import { emptySubmissionProgress } from "./ticketSubmission.js";
import type { SubmissionProgress, TicketSubmissionOptions } from "./ticketSubmission.js";

export type TicketPlusCycleStage = "selecting-tickets" | "submitting" | "waiting-to-refresh" | "refreshing";
export type TicketPlusCycleEvent =
    | { type: "stage"; stage: TicketPlusCycleStage }
    | { type: "submission"; progress: Readonly<SubmissionProgress> }
    | { type: "attempt-reset"; submissionAttempts: number; nextPriorityIndex: number };
export type TicketPlusCycleResult = (
    | TicketPlusSubmissionResult
    | {
          outcome: "stopped";
          reason: "ticket-selection-stopped" | "refresh-stopped" | "refresh-completed";
          progress: Readonly<SubmissionProgress>;
          stopReason?: TicketRefreshResult["stopReason"];
          priorityFailure?: PriorityReason;
          refresh?: TicketRefreshResult;
      }
) & {
    submissionAttempts: number;
    reselectionFailure?: ReselectionBlockedReason;
};
export interface TicketPlusCycleOptions {
    refreshDelayMs?: number;
    selection?: TicketPriorityOptions;
    submission?: TicketSubmissionOptions;
    refresh?: TicketRefreshOptions;
}

// 只編排同場次、同輪順位；沒有經驗證的刷新完成訊號前，耗盡後更新一次即停止。
export async function runTicketPlusCycle(
    page: Page,
    input: TicketPlusActivitySettings,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    observer?: (event: TicketPlusCycleEvent) => void | Promise<void>,
    options: TicketPlusCycleOptions = {},
): Promise<TicketPlusCycleResult> {
    let progress = emptySubmissionProgress();
    let submissionAttempts = 0;
    const notify = (event: TicketPlusCycleEvent) => {
        try {
            void Promise.resolve(observer?.(event)).catch(() => {});
        } catch {
            // 通知不得改變本次提交結果或觸發重試。
        }
    };
    const reset = (nextPriorityIndex: number) => {
        progress = emptySubmissionProgress();
        notify({ type: "attempt-reset", submissionAttempts, nextPriorityIndex });
    };
    try {
        // 複製設定並確認同場次能力，等待使用原本的全程控制。
        control.check();
        const activity = parseTicketPlusActivity(input);
        ticketPlusSessionSelection(activity);
        const delay = options.refreshDelayMs ?? 1_000;
        if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) {
            throw new TicketPlusPriorityError("invalid-options");
        }
        let nextPriorityIndex = 0;
        reset(nextPriorityIndex);

        // 使用原始順位索引；每個順位在本輪最多提交一次，其他錯誤不能候補。
        while (nextPriorityIndex < activity.targets.length) {
            control.check();
            notify({ type: "stage", stage: "selecting-tickets" });
            let selected;
            try {
                selected = await selectTicketPlusPriority(
                    page,
                    activity,
                    session,
                    {
                        ...options.selection,
                        startPriorityIndex: nextPriorityIndex,
                        requireZeroInitialQuantity:
                            submissionAttempts > 0 || options.selection?.requireZeroInitialQuantity,
                    },
                    control,
                );
            } catch (error) {
                control.check();
                if (error instanceof TicketPlusPriorityError && error.reason === "all-targets-sold-out") break;
                throw error;
            }

            // 本次進度獨立累積；總提交次數僅供摘要，不帶入之前的 failure。
            notify({ type: "stage", stage: "submitting" });
            const result = await runTicketPlusSubmission(
                page,
                selected.selection,
                selected.snapshot,
                options.submission,
                observed => {
                    if (observed.submitAttempted && !progress.submitAttempted) submissionAttempts++;
                    progress = { ...observed };
                    notify({ type: "submission", progress: Object.freeze({ ...progress }) });
                },
                control,
            );
            if (result.outcome !== "rejected" || result.progress.failure !== "sold-out" || result.stopReason) {
                return { ...result, submissionAttempts };
            }

            // 關窗後重新核對；ready 僅是當下快照，下一次選票仍強制全零。
            const readiness = await inspectTicketPlusReselection(page, session, result, control);
            if (readiness.kind !== "ready") {
                return { ...result, submissionAttempts, reselectionFailure: readiness.reason };
            }
            nextPriorityIndex = selected.priorityIndex + 1;
            reset(nextPriorityIndex);
        }

        // 只有設定目標耗盡才更新，非目標庫存不影響；更新仍會核對全頁已選零張。
        control.check();
        notify({ type: "stage", stage: "waiting-to-refresh" });
        await control.wait(delay);
        control.check();
        notify({ type: "stage", stage: "refreshing" });
        const refresh = await refreshTicketPlusTickets(page, session, control, options.refresh);
        return {
            outcome: "stopped",
            reason: refresh.kind === "completed" ? "refresh-completed" : "refresh-stopped",
            progress: Object.freeze({ ...progress }),
            submissionAttempts,
            refresh,
            ...(refresh.stopReason ? { stopReason: refresh.stopReason } : {}),
        };
    } catch (error) {
        // 取消保留當次提交事實；前次已確認售完不污染這一次的結果。
        let cause = error;
        try {
            control.check();
        } catch (stop) {
            if (stop instanceof TicketPlusStopError) cause = stop;
        }
        if (cause instanceof TicketPlusStopError || progress.submitAttempted || progress.failure) {
            return { ...stoppedSubmissionResult(cause, progress), submissionAttempts };
        }
        return {
            outcome: "stopped",
            reason: "ticket-selection-stopped",
            progress: Object.freeze({ ...progress }),
            submissionAttempts,
            ...(cause instanceof TicketPlusPriorityError ? { priorityFailure: cause.reason } : {}),
        };
    }
}
