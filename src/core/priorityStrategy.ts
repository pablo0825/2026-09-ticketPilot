import { emitRunEvent } from "./logger.js";
import { validatePurchaseConfig } from "./purchaseValidation.js";
import type { PurchaseConfig, PurchaseTarget } from "./types.js";
import { PurchaseStop } from "./purchaseStop.js";

export type AttemptResult<T> =
    | { status: "matched"; value: T }
    // disabled 表示日期、時間或票種在送出前不可選，且 adapter 已確認仍可在選票頁繼續。
    | { status: "unavailable"; reason: "sold-out" | "assignment-failed" | "disabled" };

export interface TargetAttempt<T> {
    // matched 僅代表配位核對完成，尚未確認座位。
    attempt(target: PurchaseTarget): Promise<AttemptResult<T>>;
    // 只處理本次已辨識失敗；按一次並驗證安全返回，否則拋錯。
    returnAfterFailure(): Promise<void>;
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
            // 取出這個順位，並通知畫面目前的目標
            const target = structuredClone(this.config.targets[this.index]!);
            emitRunEvent({
                type: "target",
                index: this.index + 1,
                total: this.config.targets.length,
                area: target.area,
                quantity: target.quantity,
                date: target.date,
                time: target.time,
                totalPrice: target.expectation.totalPrice,
            });

            // 嘗試這個順位，成功就直接回傳
            const result = await adapter.attempt(target);
            if (result.status === "matched") return { target, value: result.value };

            // 送出前停用可直接換順位；送出後失敗則必須先安全返回。
            // 返回失敗不得交給外層 recovery，亦不得先前進順位。
            if (result.reason !== "disabled") {
                try {
                    await adapter.returnAfterFailure();
                } catch {
                    throw new PurchaseStop("失敗後未能安全返回選票，已停止；不換區、不重按或轉用恢復額度。");
                }
            }

            this.index++;
        }

        throw new PurchaseStop("NO_TARGET_AVAILABLE：所有設定目標皆明確失敗或目前停用。");
    }
}
