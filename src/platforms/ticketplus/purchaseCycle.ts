import type { Page } from "playwright";
import {
    parseTicketPlusActivity,
    ticketPlusFlowType,
    ticketPlusSessionSelection,
} from "../../config/platforms/ticketplus/activitySettings.js";
import type { TicketPlusActivitySettings } from "../../config/platforms/ticketplus/activitySettings.js";
import { submitTicketPlusInformation } from "./informationSubmission.js";
import type {
    InformationSubmissionOptions,
    InformationSubmissionReason,
    InformationSubmissionResult,
} from "./informationSubmission.js";
import { inspectTicketPlusReselection } from "./reselectionReadiness.js";
import type { ReselectionBlockedReason } from "./reselectionReadiness.js";
import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import type { TicketPlusStopReason } from "./runControl.js";
import { runTicketPlusSubmission, stoppedSubmissionResult } from "./submissionOutcome.js";
import type { TicketPlusSubmissionResult } from "./submissionOutcome.js";
import { selectTicketPlusPriority, TicketPlusPriorityError } from "./ticketPriority.js";
import type { PriorityReason, TicketPriorityOptions } from "./ticketPriority.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";
import { refreshTicketPlusTickets } from "./ticketRefresh.js";
import type { TicketRefreshOptions, TicketRefreshResult } from "./ticketRefresh.js";
import { emptySubmissionProgress } from "./ticketSubmission.js";
import type { SubmissionProgress, TicketSubmissionOptions } from "./ticketSubmission.js";
import { recordSubmissionSynchronously } from "./submissionTracking.js";
import type { SubmissionStateRecorder } from "./submissionTracking.js";

export type TicketPlusCycleStage =
    "selecting-tickets" | "submitting" | "submitting-information" | "waiting-to-refresh" | "refreshing";
export type TicketPlusCycleEvent =
    | { type: "stage"; stage: TicketPlusCycleStage }
    | { type: "submission"; progress: Readonly<SubmissionProgress> }
    | {
          type: "attempt-reset";
          submissionAttempts: number;
          nextPriorityIndex: number;
          reason: "initial" | "next-priority" | "refreshed";
      };
export type TicketPlusCycleResult = (
    | TicketPlusSubmissionResult
    | { outcome: "payment-ready"; progress: Readonly<SubmissionProgress>; stopReason?: undefined }
    | {
          outcome: "stopped" | "unknown";
          reason: "information-stopped";
          informationFailure: InformationSubmissionReason;
          progress: Readonly<SubmissionProgress>;
          stopReason?: TicketPlusStopReason;
      }
    | {
          outcome: "stopped";
          reason: "ticket-selection-stopped" | "refresh-stopped" | "cycle-limit-missing";
          progress: Readonly<SubmissionProgress>;
          stopReason?: TicketRefreshResult["stopReason"];
          priorityFailure?: PriorityReason;
          refresh?: TicketRefreshResult;
      }
) & {
    submissionAttempts: number;
    reselectionFailure?: ReselectionBlockedReason;
    // 抵達資料頁時本次提交的張數；抽選核對參加者列數使用。
    submittedQuantity?: number;
};
export interface TicketPlusCycleOptions {
    refreshDelayMs?: number;
    selection?: TicketPriorityOptions;
    submission?: TicketSubmissionOptions;
    refresh?: TicketRefreshOptions;
    information?: InformationSubmissionOptions;
}

// 資料頁送出結果轉成本輪結果；點擊前的期限與停止保留 stopReason，訊息據此說明未送出。
function informationCycleResult(
    submitted: InformationSubmissionResult,
    progress: SubmissionProgress,
    submissionAttempts: number,
): TicketPlusCycleResult {
    const frozen = Object.freeze({ ...progress });
    if (submitted.outcome === "payment-ready")
        return { outcome: "payment-ready", progress: frozen, submissionAttempts };
    const stopReason: TicketPlusStopReason | undefined =
        submitted.reason === "time-limit"
            ? "time-limit"
            : submitted.reason === "user-stopped"
              ? "user-stop"
              : undefined;
    return {
        outcome: submitted.outcome,
        reason: "information-stopped",
        informationFailure: submitted.reason,
        progress: frozen,
        submissionAttempts,
        ...(stopReason ? { stopReason } : {}),
    };
}

// 編排同場次順位；只有更新完成且原全程期限有效，才從第一順位開始新一輪。
export async function runTicketPlusCycle(
    page: Page,
    input: TicketPlusActivitySettings,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    observer?: (event: TicketPlusCycleEvent) => void | Promise<void>,
    options: TicketPlusCycleOptions = {},
    recorder?: SubmissionStateRecorder,
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
    const reset = (nextPriorityIndex: number, reason: "initial" | "next-priority" | "refreshed") => {
        progress = emptySubmissionProgress();
        recordSubmissionSynchronously(() =>
            recorder?.({ progress: Object.freeze({ ...progress }), submissionAttempts }),
        );
        notify({ type: "attempt-reset", submissionAttempts, nextPriorityIndex, reason });
    };
    try {
        // 複製設定並確認同場次能力，等待使用原本的全程控制。
        control.check();
        const activity = parseTicketPlusActivity(input);
        const flowType = ticketPlusFlowType(activity);
        ticketPlusSessionSelection(activity);
        const delay = options.refreshDelayMs ?? 1_000;
        if (!Number.isFinite(delay) || delay <= 0 || delay > 2_147_483_647) {
            throw new TicketPlusPriorityError("invalid-options");
        }
        let nextPriorityIndex = 0;
        reset(nextPriorityIndex, "initial");

        let hasRefreshed = false;
        // 每輪共用原停止控制與累計提交次數，不重開瀏覽器或重新計時。
        while (true) {
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
                                hasRefreshed || submissionAttempts > 0 || options.selection?.requireZeroInitialQuantity,
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
                        notify({ type: "submission", progress: observed });
                    },
                    control,
                    observed => {
                        if (observed.submitAttempted && !progress.submitAttempted) submissionAttempts++;
                        progress = { ...observed };
                        return recorder?.({ progress: Object.freeze({ ...progress }), submissionAttempts });
                    },
                );
                // 購票到資料頁後勾條款並送出一次，停在付款頁；抽選原樣交回人工確認流程。
                if (result.outcome === "information-ready" && flowType === "purchase") {
                    notify({ type: "stage", stage: "submitting-information" });
                    const submitted = await submitTicketPlusInformation(page, session, control, options.information);
                    return informationCycleResult(submitted, progress, submissionAttempts);
                }
                if (result.outcome === "information-ready") {
                    return {
                        ...result,
                        submissionAttempts,
                        submittedQuantity: activity.targets[selected.priorityIndex]!.quantity,
                    };
                }
                if (result.outcome !== "rejected" || result.progress.failure !== "sold-out" || result.stopReason) {
                    return { ...result, submissionAttempts };
                }

                // 關窗後重新核對；ready 僅是當下快照，下一次選票仍強制全零。
                const readiness = await inspectTicketPlusReselection(page, session, result, control);
                if (readiness.kind !== "ready") {
                    return { ...result, submissionAttempts, reselectionFailure: readiness.reason };
                }
                nextPriorityIndex = selected.priorityIndex + 1;
                reset(nextPriorityIndex, "next-priority");
            }

            // 只有設定目標耗盡才更新，非目標庫存不影響；更新仍會核對全頁已選零張。
            control.check();
            notify({ type: "stage", stage: "waiting-to-refresh" });
            await control.wait(delay);
            control.check();
            notify({ type: "stage", stage: "refreshing" });
            const refresh = await refreshTicketPlusTickets(page, session, control, options.refresh);
            if (refresh.kind !== "completed") {
                return {
                    outcome: "stopped",
                    reason: "refresh-stopped",
                    progress: Object.freeze({ ...progress }),
                    submissionAttempts,
                    refresh,
                    ...(refresh.stopReason ? { stopReason: refresh.stopReason } : {}),
                };
            }

            // 更新成功只是新一輪的起點；缺少全程期限的獨立呼叫不能無限重跑。
            control.check();
            if (!Number.isFinite(control.remainingMs())) {
                return {
                    outcome: "stopped",
                    reason: "cycle-limit-missing",
                    progress: Object.freeze({ ...progress }),
                    submissionAttempts,
                    refresh,
                };
            }
            hasRefreshed = true;
            nextPriorityIndex = 0;
            reset(nextPriorityIndex, "refreshed");
        }
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
