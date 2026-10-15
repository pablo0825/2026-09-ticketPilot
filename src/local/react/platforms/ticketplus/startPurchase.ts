import type { PurchaseSnapshot } from "../../../purchaseRuns.js";
import { ticketPlusSessionSelection } from "../../../../config/ticketPlusActivity.js";
import { api } from "../../shared/api.js";
import type { ApiError } from "../../shared/api.js";
import type { TicketPlusActivityRecord } from "./formModel.js";

const pendingKey = "ticketpilot-ticketplus-purchase-request";
interface PendingRequest {
    version: 1;
    requestId: string;
    activityId: string;
    signature: string;
}

export function hasPendingStart(): boolean {
    return sessionStorage.getItem(pendingKey) !== null;
}

function readPending(): PendingRequest | null {
    const raw = sessionStorage.getItem(pendingKey);
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw);
        if (
            value?.version !== 1 ||
            typeof value.requestId !== "string" ||
            !value.requestId ||
            typeof value.activityId !== "string" ||
            !value.activityId ||
            typeof value.signature !== "string" ||
            !value.signature
        ) {
            throw new Error();
        }
        return value;
    } catch {
        throw new Error("待確認的 TicketPlus 啟動紀錄無法讀取，請先檢查原流程；不會建立新的購票請求。");
    }
}

function acceptedRun(value: PurchaseSnapshot | null, pending: PendingRequest): boolean {
    return Boolean(
        value &&
        value.platform === "ticketplus" &&
        value.requestId === pending.requestId &&
        typeof value.id === "string" &&
        value.id,
    );
}

export async function findPendingStart(): Promise<PurchaseSnapshot> {
    // 查不到目前這筆，不能推論原請求未被接受，更不能清掉識別碼。
    const pending = readPending();
    if (!pending) throw new Error("沒有待確認的 TicketPlus 啟動請求。");
    const current = await api<PurchaseSnapshot | null>("/api/purchase");
    if (!current || !acceptedRun(current, pending)) {
        throw new Error("目前狀態無法核對原啟動請求，請檢查原流程；待確認紀錄已保留，不會自動重新開始。");
    }
    sessionStorage.removeItem(pendingKey);
    return current;
}

export async function startPurchase(record: TicketPlusActivityRecord): Promise<PurchaseSnapshot> {
    // 摘要與請求使用已保存的同一份設定，不在啟動時偷偷儲存草稿。
    ticketPlusSessionSelection(record.settings);
    const signature = JSON.stringify(record.settings);
    let pending = readPending();
    if (pending && (pending.activityId !== record.id || pending.signature !== signature)) {
        throw new Error("上一筆 TicketPlus 啟動結果尚待確認，不能更換活動或設定；請先查看待確認的啟動結果。");
    }

    // 回應遺失時先核對即時狀態；仍需重查啟動時只沿用原請求。
    if (pending) {
        const current = await api<PurchaseSnapshot | null>("/api/purchase");
        if (current && acceptedRun(current, pending)) {
            sessionStorage.removeItem(pendingKey);
            return current;
        }
        if (current?.occupied) throw new Error("目前仍有購票占用，原啟動結果尚待確認；不會另開購票流程。");
    } else {
        pending = { version: 1, requestId: crypto.randomUUID(), activityId: record.id, signature };
        sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    }

    // 只有明確接受或明確未接受才能清除暫存，網路錯誤不授權另開一輪。
    try {
        const result = await api<PurchaseSnapshot>("/api/purchase", "POST", {
            requestId: pending.requestId,
            activityId: pending.activityId,
            expectedActivity: record.settings,
        });
        if (!acceptedRun(result, pending)) throw new Error("無法核對啟動回應，請查看待確認的啟動結果。");
        sessionStorage.removeItem(pendingKey);
        return result;
    } catch (error) {
        if ((error as ApiError).notAccepted === true) sessionStorage.removeItem(pendingKey);
        throw error;
    }
}
