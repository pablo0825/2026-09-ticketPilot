import type { PurchaseConfig, PurchaseTarget } from "./types.js";
import { PurchaseStop } from "./purchaseStop.js";

export type AttemptResult<T> =
    | { status: "matched"; value: T }
    | { status: "unavailable"; reason: "sold-out" | "assignment-failed" };

export interface TargetAttempt<T> {
    // matched 僅代表配位核對完成，尚未確認座位。
    attempt(target: PurchaseTarget): Promise<AttemptResult<T>>;
    // 只處理本次已辨識失敗；按一次並驗證安全返回，否則拋錯。
    returnAfterFailure(): Promise<void>;
}

export function validatePurchaseConfig(config: PurchaseConfig): void {
    if (config.fallbackMode !== "STRICT" || config.targets.length === 0) {
        throw new Error("必須設定 STRICT 與至少一個目標。");
    }
    for (const target of config.targets) {
        const date = new Date(`${target.date}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(target.date) || Number.isNaN(date.getTime()) ||
            date.toISOString().slice(0, 10) !== target.date || !/^([01]\d|2[0-3]):[0-5]\d$/.test(target.time) ||
            !Number.isSafeInteger(target.quantity) || target.quantity < 1 || typeof target.adjacent !== "boolean") {
            throw new Error("目標日期、時間、張數或連位設定無效。");
        }
        const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
        const area = normalize(target.area);
        if (!area || config.excludeKeywords.some(word => normalize(word) && area.includes(normalize(word)))) {
            throw new Error("目標票區空白或符合排除條件。");
        }
        const expected = target.expectation;
        if (!expected || !expected.eventName.trim() ||
            ![expected.unitPrice, expected.totalPrice].every(price => Number.isSafeInteger(price) && price > 0)) {
            throw new Error("每個目標都必須設定活動名稱、正整數單價與總價。");
        }
    }
}

// 每次程式執行建立一次，放在 prepareBooking 外；恢復重跑不會倒退順位。
export class PriorityStrategy {
    private index = 0;
    private readonly config: PurchaseConfig;

    constructor(config: PurchaseConfig) {
        validatePurchaseConfig(config);
        this.config = structuredClone(config);
    }

    async select<T>(adapter: TargetAttempt<T>): Promise<{ target: PurchaseTarget; value: T }> {
        while (this.index < this.config.targets.length) {
            const target = structuredClone(this.config.targets[this.index]!);
            const result = await adapter.attempt(target);
            if (result.status === "matched") return { target, value: result.value };
            // 返回失敗不得交給外層 recovery，亦不得先前進順位。
            try {
                await adapter.returnAfterFailure();
            } catch {
                throw new PurchaseStop("失敗後未能安全返回選票，已停止；不換區、不重按或轉用恢復額度。");
            }
            this.index++;
        }
        throw new PurchaseStop("NO_TARGET_AVAILABLE：所有設定目標皆明確失敗。");
    }
}
