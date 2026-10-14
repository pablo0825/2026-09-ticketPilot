import { PurchaseLockError } from "../app/purchaseLock.js";
import type { SessionEntryReason, SessionEntryStage } from "../platforms/ticketplus/sessionSelection.js";

// 只顯示自行建立的固定訊息，不轉印檔案、DOM 或瀏覽器原始例外。
export class TicketPlusCliInputError extends Error {}

export function ticketPlusStartupMessage(error: unknown): string {
    if (error instanceof PurchaseLockError) {
        if (error.reason === "occupied") {
            return "TicketPlus 未啟動：購票占用尚未解除（local-data/purchase.lock）。可能有 Klook／TicketPlus 購票瀏覽器仍在使用，或上次程序異常中斷。請先確認原瀏覽器與訂單狀態；不會自動清鎖或重跑。";
        }
        if (error.reason === "unavailable") {
            return "TicketPlus 未啟動：無法建立購票占用。請檢查 local-data 目錄權限與磁碟狀態；不會自動重跑。";
        }
        return "TicketPlus 未啟動：購票占用檔案無法讀取或識別不符。請檢查原程序與占用檔案；不會自動清鎖或重跑。";
    }
    if (error instanceof TicketPlusCliInputError) return `TicketPlus 未啟動：${error.message}`;
    return "TicketPlus 啟動發生未分類錯誤。請先確認購票瀏覽器與訂單狀態；不會自動清鎖或重跑。";
}

const sessionReasons: Record<SessionEntryReason, string> = {
    "invalid-settings": "活動設定無效，請檢查活動網址、名稱及場次日期時間",
    "invalid-options": "場次操作的等待時間設定無效",
    "unexpected-page": "目前頁面不是可辨識的預期頁面，請確認登入狀態、活動頁及是否有彈窗",
    "activity-mismatch": "頁面活動名稱或活動 ID 與設定不符，請核對 eventName 與 eventUrl",
    "session-missing": "找不到符合日期與時間的場次，請核對 target.date 與 target.time",
    "session-ambiguous": "同日期與時間有多個場次，無法唯一選擇，請人工確認",
    "session-disabled": "目標場次的立即購買按鈕目前停用，請查看網站狀態；不能僅據此判定尚未開賣或已售完",
    "session-changed": "點擊前場次資料已改變，請重新核對頁面",
    "button-unavailable": "無法唯一定位可用的立即購買按鈕，請檢查頁面是否已變動",
    "click-failed": "立即購買的點擊結果未確認，請檢查目前頁面",
    "arrival-mismatch": "進入的選票頁與設定活動或場次不符，請核對活動及日期時間",
    "arrival-timeout": "等待選票頁逾時，請檢查目前是否仍在處理或已完成跳轉",
    "read-failed": "無法完成頁面資料讀取，請檢查瀏覽器是否關閉、頁面載入或變動",
};

export function ticketPlusSessionMessage(failure: { reason: SessionEntryReason; stage: SessionEntryStage }): string {
    const attempt =
        failure.stage === "before-click"
            ? "尚未嘗試點擊立即購買"
            : "已嘗試點擊立即購買，請先人工確認目前頁面，不會再次點擊";
    return `場次選擇停止（${failure.reason}）：${sessionReasons[failure.reason]}。${attempt}；尚未嘗試選票提交，不會自動重跑。`;
}
