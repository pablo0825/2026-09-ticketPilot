import { TicketPlusCapabilityError } from "../config/ticketPlusActivity.js";
import { PurchaseLockError } from "../app/purchaseLock.js";
export { ticketPlusSessionMessage } from "../app/ticketPlusPresentation.js";

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
    if (error instanceof TicketPlusCliInputError || error instanceof TicketPlusCapabilityError)
        return `TicketPlus 未啟動：${error.message}`;
    return "TicketPlus 啟動發生未分類錯誤。請先確認購票瀏覽器與訂單狀態；不會自動清鎖或重跑。";
}
