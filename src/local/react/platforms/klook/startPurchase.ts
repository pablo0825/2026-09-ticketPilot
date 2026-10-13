import type { ActivityRecord, ActivitySettings } from "../../../../config/activityStore.js";
import type { ContactDetails } from "../../../../config/contact.config.js";
import type { PurchaseSnapshot } from "../../../purchaseRuns.js";
import type { ActivityDraft } from "./formModel.js";
import { api } from "../../shared/api.js";
import type { ApiError } from "../../shared/api.js";

interface PendingRequest {
    version: 2;
    requestId: string;
    activityId: string;
    signature: string;
}

export async function startPurchase(
    record: ActivityRecord,
    activity: ActivityDraft,
    contact: ContactDetails,
    onSaved: (record: ActivityRecord) => void,
): Promise<PurchaseSnapshot> {
    // 沿用未確定結果的請求；設定變更時停止而非建立另一筆
    const key = "ticketpilot-purchase-request";
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ activity, contact })));
    const signature = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    let pending = JSON.parse(sessionStorage.getItem(key) || "null") as PendingRequest | null;
    if (pending && pending.version !== 2)
        throw new Error("舊版開始請求結果尚待確認，請檢查目前流程與訂單；不會自動重新開始。");
    if (pending && (pending.activityId !== record.id || pending.signature !== signature)) {
        throw new Error("上一筆開始請求結果尚待確認，不能更換設定或再次保存；請查看目前狀態。");
    }

    // 開始前保存時間設定，版本核對保護其他分頁的修改
    if (!pending) {
        if (JSON.stringify(activity) !== JSON.stringify(record.settings)) {
            onSaved(await api<ActivityRecord>("/api/activities/" + record.id, "PUT", activity, record.updatedAt));
        }
        pending = { version: 2, requestId: crypto.randomUUID(), activityId: record.id, signature };
        sessionStorage.setItem(key, JSON.stringify(pending));
    }

    // 只在確定接受或明確拒絕時移除請求，網路中斷仍保留識別碼
    let result: PurchaseSnapshot;
    try {
        result = await api<PurchaseSnapshot>("/api/purchase", "POST", {
            requestId: pending.requestId,
            activityId: pending.activityId,
            expectedActivity: activity,
            expectedContact: contact,
        });
    } catch (error) {
        if ((error as ApiError).notAccepted) sessionStorage.removeItem(key);
        throw error;
    }
    sessionStorage.removeItem(key);
    return result;
}
