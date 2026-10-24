import type { SubmissionProgress } from "./ticketSubmission.js";

export type SubmissionRecorder = (progress: Readonly<SubmissionProgress>) => void;
export interface SubmissionState {
    progress: Readonly<SubmissionProgress>;
    submissionAttempts: number;
}
export type SubmissionStateRecorder = (state: Readonly<SubmissionState>) => void;

// 安全紀錄只能同步更新記憶體。void 回呼仍可能被傳入 async 函式，必須在執行期拒絕。
// 回傳 Promise 時只接住其拒絕，不能等待後繼續點擊；紀錄失敗交給流程保守停止。
export function recordSubmissionSynchronously(record: () => void): void {
    const result: unknown = record();
    if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
        throw new Error("提交狀態必須同步記錄，已停止後續操作。");
    }
}
