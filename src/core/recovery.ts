import { PurchaseStop } from "./purchaseStop.js";
import { log, emitRunEvent } from "./logger.js";
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
export async function runWithRecovery<T>(
    attempt: () => Promise<T>,
    findRecovery: () => Promise<RecoveryAction | null>,
): Promise<T> {
    const used = { queue: false, reservation: false };

    async function recoverOnce(action: RecoveryAction): Promise<void> {
        // 先扣額度，用過就停止
        const label = action.kind === "queue" ? "獨立排隊" : "選位／個資預留";
        if (used[action.kind]) throw new Error(`${label}已達一次恢復上限，請人工檢查。`);
        used[action.kind] = true;

        // 回報恢復狀態
        emitRunEvent({ type: "recovery", queue: Number(used.queue), reservation: Number(used.reservation) });
        reportState("RECOVERING");
        log(`${label}恢復額度：1/1（已使用）。`);

        // 執行恢復，完成後回報已回到活動頁
        await action.recover();
        reportState("EVENT_PAGE");
    }

    while (true) {
        // 每一輪先檢查是否需要恢復，需要就先處理再重來
        const initial = await findRecovery();
        if (initial) {
            await recoverOnce(initial);
            continue;
        }

        // 執行流程；失敗時只處理認得的恢復情況
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
