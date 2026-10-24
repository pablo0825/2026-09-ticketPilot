import type { ActivitySettings } from "../config/activitySettings.js";

import type { RunStopReason, RunCapabilities } from "./runControls.js";
import type { PurchaseEvent } from "./runEvents.js";

export interface PurchaseSnapshot {
    platform: ActivitySettings["platform"] | null; // 外部占用沒有足夠資訊可辨識平台。
    id: string;
    requestId: string;
    activityName: string;
    saleAt?: string;
    flowType?: "purchase" | "lottery"; // 只有 TicketPlus 新紀錄才有；舊紀錄沒有時畫面退回純紀錄。
    stopReason?: RunStopReason; // TicketPlus 因使用者停止或時間上限結束時才有。
    activityId?: string; // 從紀錄的活動資料帶出給畫面對應活動列表，不另外存檔。
    status:
        "running" | "payment-ready" | "information-ready" | "registration-ready" | "failed" | "unknown" | "interrupted";
    canCloseBrowser?: boolean;
    canStop?: boolean;
    capabilities?: RunCapabilities; // 舊快照可缺少；缺少能力不授權任何新操作。
    stopRequest?: { status: "sending" | "sent" | "unconfirmed" };
    loginConfirmation?: { confirmationId: string }; // 相容舊快照型別；新流程不產生人工確認資格。
    participantConfirmation?: { confirmationId: string }; // 抽選等待參加者時才提供，確認送出後即移除。
    browserOpen: boolean;
    occupied: boolean;
    message: string;
    events: { sequence: number; at: string; event: PurchaseEvent }[];
    historyTruncated: boolean;
}
