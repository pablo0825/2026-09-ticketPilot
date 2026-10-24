// 共用的使用者操作與期限結果；平台內部失敗原因仍留在各平台。
export type RunStopReason = "user-stop" | "time-limit";
export interface RunCapabilities {
    stop: boolean;
    participants: boolean;
}
