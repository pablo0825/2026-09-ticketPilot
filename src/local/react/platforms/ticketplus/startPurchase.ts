import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";
import {
    parseTicketPlusActivity,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
} from "../../../../config/platforms/ticketplus/activitySettings.js";
import type { TicketPlusActivitySettings } from "../../../../config/platforms/ticketplus/activitySettings.js";
import { api } from "../../shared/api.js";
import type { ApiError } from "../../shared/api.js";
import type { TicketPlusActivityRecord } from "./formModel.js";
import { ticketPlusRecord } from "./formModel.js";

import {
    readPendingStart,
    createPendingStart,
    clearPendingStart,
    matchesPendingRun,
} from "../../shared/runs/pendingStart.js";
export { hasPendingStart, findPendingStart } from "../../shared/runs/pendingStart.js";

export async function startPurchase(
    record: TicketPlusActivityRecord,
    candidate: TicketPlusActivitySettings,
    onSaved: (record: TicketPlusActivityRecord) => void,
): Promise<PurchaseSnapshot> {
    // 核對本次設定；上一筆結果未明時，不得先覆寫活動或建立新請求。
    const settings = parseTicketPlusActivity(candidate);
    ticketPlusSessionSelection(settings);
    const signature = JSON.stringify(settings);
    let pending = readPendingStart();
    if (
        pending &&
        (pending.platform !== settings.platform || pending.activityId !== record.id || pending.signature !== signature)
    ) {
        throw new Error("上一筆 TicketPlus 啟動結果尚待確認，不能更換活動或設定；請先查看待確認的啟動結果。");
    }

    // 回應遺失時先核對即時狀態；仍需重查啟動時只沿用原請求。
    if (pending) {
        const current = await api<PurchaseSnapshot | null>("/api/purchase");
        if (current && matchesPendingRun(current, pending)) {
            clearPendingStart(pending);
            return current;
        }
        if (current?.occupied) throw new Error("目前仍有購票占用，原啟動結果尚待確認；不會另開購票流程。");
    } else {
        validateTicketPlusRunSettings(settings);
        // 先保存執行設定並接受新版本，再送出購票請求。
        if (JSON.stringify(record.settings) !== signature) {
            let response: unknown;
            try {
                response = await api<unknown>("/api/activities/" + record.id, "PUT", settings, record.updatedAt);
            } catch (error) {
                throw new Error(`未能確認執行設定已保存：${(error as Error).message}。尚未啟動購票，請重新核對設定。`);
            }
            const saved = ticketPlusRecord(response, record.id);
            if (JSON.stringify(saved.settings) !== signature) {
                throw new Error("保存回應與本次設定不符，請重新核對；尚未啟動購票。");
            }
            onSaved(saved);
        }
        pending = createPendingStart({
            platform: settings.platform,
            requestId: crypto.randomUUID(),
            activityId: record.id,
            signature,
        });
    }

    // 只有明確接受或明確未接受才能清除暫存，網路錯誤不授權另開一輪。
    try {
        const result = await api<PurchaseSnapshot>("/api/purchase", "POST", {
            requestId: pending.requestId,
            activityId: pending.activityId,
            expectedActivity: settings,
        });
        if (!matchesPendingRun(result, pending)) throw new Error("無法核對啟動回應，請查看待確認的啟動結果。");
        clearPendingStart(pending);
        return result;
    } catch (error) {
        if ((error as ApiError).notAccepted === true) clearPendingStart(pending);
        throw error;
    }
}
