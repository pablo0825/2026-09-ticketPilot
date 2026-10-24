import type { PurchaseSnapshot } from "../../../shared/runSnapshot.js";
import { api } from "../api.js";

// 舊 Klook 的 ticketpilot-purchase-request 不屬於可執行平台，不讀取或覆寫。
export const pendingStartKey = "ticketpilot-platform-purchase-request";
export const legacyTicketPlusPendingKey = "ticketpilot-ticketplus-purchase-request";

interface PendingStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface PendingStart {
    platform: string;
    requestId: string;
    activityId: string;
    signature: string;
    source: { key: string; raw: string };
}

type PendingInput = Omit<PendingStart, "source">;

function nonempty(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

function parsePending(raw: string, key: string): PendingStart {
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== "object") throw new Error();
        const legacy = key === legacyTicketPlusPendingKey;
        if (
            !("version" in value) ||
            value.version !== (legacy ? 1 : 2) ||
            !("requestId" in value) ||
            !nonempty(value.requestId) ||
            !("activityId" in value) ||
            !nonempty(value.activityId) ||
            !("signature" in value) ||
            !nonempty(value.signature)
        )
            throw new Error();
        const platform = legacy ? "ticketplus" : "platform" in value ? value.platform : undefined;
        if (!nonempty(platform)) throw new Error();
        return {
            platform,
            requestId: value.requestId,
            activityId: value.activityId,
            signature: value.signature,
            source: { key, raw },
        };
    } catch {
        throw new Error("待確認的啟動紀錄無法讀取，請先檢查原流程；不會建立新的購票請求。");
    }
}

export function hasPendingStart(storage: PendingStorage = sessionStorage): boolean {
    return [pendingStartKey, legacyTicketPlusPendingKey].some(key => storage.getItem(key) !== null);
}

export function readPendingStart(storage: PendingStorage = sessionStorage): PendingStart | null {
    const records = [pendingStartKey, legacyTicketPlusPendingKey].flatMap(key => {
        const raw = storage.getItem(key);
        return raw === null ? [] : [{ key, raw }];
    });
    // 不猜測兩份紀錄的先後，也不因其中一份損壞而忽略它。
    if (records.length > 1) throw new Error("有多筆待確認的啟動紀錄，請先檢查原流程；不會建立新的購票請求。");
    const record = records[0];
    return record ? parsePending(record.raw, record.key) : null;
}

export function createPendingStart(input: PendingInput, storage: PendingStorage = sessionStorage): PendingStart {
    if (hasPendingStart(storage)) throw new Error("上一筆啟動結果尚待確認，不會建立新的購票請求。");
    const raw = JSON.stringify({ version: 2, ...input });
    const pending = parsePending(raw, pendingStartKey);
    storage.setItem(pendingStartKey, raw);
    return pending;
}

export function clearPendingStart(pending: PendingStart, storage: PendingStorage = sessionStorage): void {
    // 請求等待期間若紀錄已被替換，舊回應不能清除新紀錄。
    const current = readPendingStart(storage);
    if (current?.source.key !== pending.source.key || current.source.raw !== pending.source.raw) {
        throw new Error("待確認的啟動紀錄已變更，紀錄已保留；請重新核對原流程。");
    }
    storage.removeItem(pending.source.key);
}

export function matchesPendingRun(value: PurchaseSnapshot | null, pending: PendingStart): boolean {
    return Boolean(
        value && value.platform === pending.platform && value.requestId === pending.requestId && nonempty(value.id),
    );
}

export async function findPendingStart(): Promise<PurchaseSnapshot> {
    const pending = readPendingStart();
    if (!pending) throw new Error("沒有待確認的啟動請求。");
    const current = await api<PurchaseSnapshot | null>("/api/purchase");
    // 查不到目前這筆，不能推論原請求未被接受，更不能清掉識別碼。
    if (!current || !matchesPendingRun(current, pending)) {
        throw new Error("目前狀態無法核對原啟動請求，請檢查原流程；待確認紀錄已保留，不會自動重新開始。");
    }
    clearPendingStart(pending);
    return current;
}
