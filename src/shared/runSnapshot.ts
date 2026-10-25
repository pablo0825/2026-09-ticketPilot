import type { ActivitySettings } from "../config/activitySettings.js";
import type { RunStopReason, RunCapabilities } from "./runControls.js";
import type { PurchaseEvent } from "./runEvents.js";

// 執行紀錄的存檔欄位；型別用來防止直接誤寫 GUI 欄位，不會過濾執行期資料。
export interface RunSnapshot {
    platform: ActivitySettings["platform"];
    id: string;
    requestId: string;
    activityName: string;
    saleAt?: string;
    flowType?: "purchase" | "lottery"; // 只有 TicketPlus 新紀錄才有；舊紀錄沒有時畫面退回純紀錄。
    stopReason?: RunStopReason; // TicketPlus 因使用者停止或時間上限結束時才有。

    status:
        "running" | "payment-ready" | "information-ready" | "registration-ready" | "failed" | "unknown" | "interrupted";

    browserOpen: boolean;
    occupied: boolean;

    message: string;
    events: { sequence: number; at: string; event: PurchaseEvent }[];
    historyTruncated: boolean;
}

// GUI 快照包含紀錄欄位，以及依目前狀況帶入的活動識別碼與操作資格。
export interface PurchaseSnapshot extends Omit<RunSnapshot, "platform"> {
    platform: RunSnapshot["platform"] | null; // 外部占用沒有足夠資訊可辨識平台。
    activityId?: string; // 從紀錄的活動資料帶出給畫面對應活動列表，不另外存檔。
    canCloseBrowser?: boolean;
    canStop?: boolean;
    capabilities?: RunCapabilities; // 舊快照可缺少；缺少能力不授權任何新操作。
    stopRequest?: { status: "sending" | "sent" | "unconfirmed" };
    loginConfirmation?: { confirmationId: string }; // 相容舊快照型別；新流程不產生人工確認資格。
    participantConfirmation?: { confirmationId: string }; // 抽選等待參加者時才提供，確認送出後即移除。
}
