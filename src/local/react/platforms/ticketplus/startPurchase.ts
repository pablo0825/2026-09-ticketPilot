import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";
import {
    parseTicketPlusActivity,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
} from "../../../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";
import { api } from "../../shared/api.js";
import type { ApiError } from "../../shared/api.js";
import type { TicketPlusActivityRecord } from "./formModel.js";
import { ticketPlusRecord } from "./formModel.js";

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

export async function startPurchase(
    record: TicketPlusActivityRecord,
    candidate: TicketPlusActivitySettings,
    onSaved: (record: TicketPlusActivityRecord) => void,
): Promise<PurchaseSnapshot> {
    // 核對本次設定；上一筆結果未明時，不得先覆寫活動或建立新請求。
    const settings = parseTicketPlusActivity(candidate);
    ticketPlusSessionSelection(settings);
    const signature = JSON.stringify(settings);
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
        pending = { version: 1, requestId: crypto.randomUUID(), activityId: record.id, signature };
        sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    }

    // 只有明確接受或明確未接受才能清除暫存，網路錯誤不授權另開一輪。
    try {
        const result = await api<PurchaseSnapshot>("/api/purchase", "POST", {
            requestId: pending.requestId,
            activityId: pending.activityId,
            expectedActivity: settings,
        });
        if (!acceptedRun(result, pending)) throw new Error("無法核對啟動回應，請查看待確認的啟動結果。");
        sessionStorage.removeItem(pendingKey);
        return result;
    } catch (error) {
        if ((error as ApiError).notAccepted === true) sessionStorage.removeItem(pendingKey);
        throw error;
    }
}
