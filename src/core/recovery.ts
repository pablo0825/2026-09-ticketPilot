import { reportState } from "./state.js";

export interface FlowRecovery {
    isRequired(): Promise<boolean>;
    // 選位／個資返回途中可接續一次排隊恢復；完成仍代表入口已就緒。
    recover(returnQueueRecovery?: FlowRecovery): Promise<void>;
}

// 只在已辨識的例外出現時重跑；不與正在執行的選票操作並行。
// 遇到例外問題的處理機制
// attempt 要執行的操作
// recovery 提供 是否需要恢復 以及 恢復方法
export async function runWithRecovery<T>(attempt: () => Promise<T>, recovery: FlowRecovery): Promise<T> {
    let recovered = false;

    // 恢復流程
    async function recoverOnce(): Promise<void> {
        // 若 recovered 為 true, 就拋出錯誤
        if (recovered) throw new Error("再次需要恢復，已達一次恢復上限，請人工檢查。");

        recovered = true;

        // 顯示 status 為恢復
        reportState("RECOVERING");

        // 紀錄正在恢復
        await recovery.recover();
        // status 為活動頁面
        reportState("EVENT_PAGE");
    }

    // 條件永遠成立
    while (true) {
        // 檢查是否需要恢復
        if (await recovery.isRequired()) {
            // 執行恢復流程
            await recoverOnce();
            // 繼續
            continue;
        }
        try {
            return await attempt();
        } catch (error) {
            // 人工取消優先於頁面上的過期提示，不得轉成重跑。
            if (error instanceof Error && error.name === "AbortError") throw error;
            // 不需要恢復，就拋出錯誤
            if (!await recovery.isRequired()) throw error;
            await recoverOnce();
        }
    }
}
