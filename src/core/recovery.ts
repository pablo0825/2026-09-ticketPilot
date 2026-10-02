import { PurchaseStop } from "./purchaseStop.js";
import { log } from "./logger.js";
import { reportState } from "./state.js";

export interface FlowRecovery {
    isRequired(): Promise<boolean>;
    // 選位／個資返回途中可接續一次排隊恢復；完成仍代表入口已就緒。
    recover(returnQueueRecovery?: FlowRecovery): Promise<void>;
}

// 種類在辨識時確定，不能在扣額度後換成另一種恢復。
export interface RecoveryAction {
    kind: "queue" | "reservation";
    recover(): Promise<void>;
}

// 整次執行各一份額度；恢復失敗直接停止，不轉用其他額度。
export async function runWithRecovery<T>(attempt: () => Promise<T>,
    findRecovery: () => Promise<RecoveryAction | null>): Promise<T> {
    const used = { queue: false, reservation: false };

    async function recoverOnce(action: RecoveryAction): Promise<void> {
        const label = action.kind === "queue" ? "獨立排隊" : "選位／個資預留";
        if (used[action.kind]) throw new Error(`${label}已達一次恢復上限，請人工檢查。`);
        used[action.kind] = true;
        reportState("RECOVERING");
        log(`${label}恢復額度：1/1（已使用）。`);
        await action.recover();
        reportState("EVENT_PAGE");
    }

    while (true) {
        const initial = await findRecovery();
        if (initial) {
            await recoverOnce(initial);
            continue;
        }
        try {
            return await attempt();
        } catch (error) {
            if (error instanceof PurchaseStop || (error instanceof Error && error.name === "AbortError")) throw error;
            const action = await findRecovery();
            if (!action) throw error;
            await recoverOnce(action);
        }
    }
}
