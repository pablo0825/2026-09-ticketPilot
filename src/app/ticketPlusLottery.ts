import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { completeTicketPlusLottery } from "../platforms/ticketplus/lotteryCompletion.js";
import type { LotteryStopReason } from "../platforms/ticketplus/lotteryCompletion.js";
import { readTicketPlusLotteryInput } from "../platforms/ticketplus/lotteryInput.js";
import { readTicketPlusPageWithMarkers } from "../platforms/ticketplus/pageState.js";
import { TicketPlusStopError } from "../platforms/ticketplus/runControl.js";
import type { TicketPlusRunControl, TicketPlusStopReason } from "../platforms/ticketplus/runControl.js";
import type { VerifiedTicketPlusSession } from "../platforms/ticketplus/ticketQuantity.js";
import type { SubmissionProgress } from "../platforms/ticketplus/ticketSubmission.js";

export type LotteryFailure = LotteryStopReason | "participant-page-changed";
export type TicketPlusLotteryResult = { submissionAttempts: number; progress: Readonly<SubmissionProgress> } & (
    | { outcome: "registration-ready"; stopReason?: undefined }
    | {
          outcome: "stopped" | "unknown";
          reason: "lottery-stopped";
          lotteryFailure: LotteryFailure;
          stopReason?: TicketPlusStopReason;
      }
);

export interface LotteryWaitHooks {
    // 等待使用者在 GUI 確認參加者已填完；resolve 表示收到確認。
    waitForParticipants: (confirmationId: string) => Promise<void>;
    onWaiting: (confirmationId: string) => void;
    onCompleting: () => void;
    pollIntervalMs?: number;
}

// 等待期間每隔一段時間讀頁：離開輸入資料頁（倒數結束、導頁、未知彈窗）即停止；
// 使用者正在編輯參加者或讀取暫時失敗都繼續等待。不讀取、不填寫參加者資料。
async function waitForConfirmation(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    confirmed: Promise<void>,
    pollIntervalMs: number,
): Promise<"confirmed" | "page-changed"> {
    let done = false;
    const signal = confirmed.then(() => {
        done = true;
    });
    while (!done) {
        control.check();
        const read = await control
            .read(() => readTicketPlusPageWithMarkers(page))
            .catch(error => {
                if (error instanceof TicketPlusStopError) throw error;
                return undefined;
            });
        if (done) break;
        if (read?.markers && readTicketPlusLotteryInput(read, session).kind === "other") return "page-changed";
        await Promise.race([control.wait(pollIntervalMs), signal]);
    }
    return "confirmed";
}

// 抽選到輸入資料頁後：等待人工確認（不計入全程期限），再勾條款、按一次下一步，停在確認登記前。
export async function finishTicketPlusLottery(
    page: Page,
    session: VerifiedTicketPlusSession,
    quantity: number,
    control: TicketPlusRunControl,
    hooks: LotteryWaitHooks,
    base: { submissionAttempts: number; progress: Readonly<SubmissionProgress> },
): Promise<TicketPlusLotteryResult> {
    const stopped = (lotteryFailure: LotteryFailure, outcome: "stopped" | "unknown" = "stopped") =>
        ({ ...base, outcome, reason: "lottery-stopped", lotteryFailure }) as const;
    try {
        // 通知等待並取得確認；等待時間不計入最長執行時間。
        const confirmationId = randomUUID();
        hooks.onWaiting(confirmationId);
        const waited = await control.excludeFromDeadline(() =>
            waitForConfirmation(
                page,
                session,
                control,
                hooks.waitForParticipants(confirmationId),
                hooks.pollIntervalMs ?? 1_000,
            ),
        );
        if (waited === "page-changed") return stopped("participant-page-changed");

        // 核對參加者後勾條款、按一次下一步。
        hooks.onCompleting();
        const result = await completeTicketPlusLottery(page, session, quantity, control);
        if (result.outcome === "registration-ready") return { ...base, outcome: "registration-ready" };
        const stopReason =
            result.reason === "time-limit" ? "time-limit" : result.reason === "user-stopped" ? "user-stop" : undefined;
        return { ...stopped(result.reason, result.outcome), ...(stopReason ? { stopReason } : {}) };
    } catch (error) {
        // 等待中或確認前停止都是未送出登記。
        if (error instanceof TicketPlusStopError) {
            return {
                ...stopped(error.stopReason === "time-limit" ? "time-limit" : "user-stopped"),
                stopReason: error.stopReason,
            };
        }
        throw error;
    }
}
