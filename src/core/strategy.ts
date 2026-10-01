import type { EventConfig, TicketAdapter } from "./types.js";
import { reportState } from "./state.js";

// config 購票設定
// adapter 操作購票網站的物件
// 驗證購票資訊，並執行選票與驗證
export async function runSelection(config: EventConfig, adapter: TicketAdapter): Promise<void> {
    // 取得購票資訊
    const target = config.targets[0];
    if (!target) throw new Error("未設定目標票券。");

    // 購票設定的 fallbackMode 是嚴格模型，不是就拋錯誤
    // 只選購票設定中的票種，失敗不自行改選其他票種
    if (config.fallbackMode !== "STRICT") throw new Error("v0.1 僅支援 STRICT。");

    // .normalize() 字串 Unicode 正規化
    // .replace 移除空白
    const area = target.area.normalize("NFKC").replace(/\s/g, "");

    // 檢查是否命中排除關鍵字
    // .some() 陣列中是否至少有一個元素通過測驗，返回 boolean
    // && 前面成立，才檢查後面
    // 確認關鍵字不是空白字串，確認關鍵字有沒有包含排除關鍵字
    if (config.excludeKeywords.some(keyword => keyword.trim() &&
        area.includes(keyword.normalize("NFKC").replace(/\s/g, "")))) {
        throw new Error("目標票區符合排除條件，已停止。");
    }

    // statuse 為選擇票卷
    reportState("TICKET_SELECTION");

    // v0.1 只處理第一筆，任何失敗都停止，不自行選其他票種。
    await adapter.selectAndVerify(target);

    // 票卷選擇已確認
    reportState("SELECTION_VERIFIED");
}
