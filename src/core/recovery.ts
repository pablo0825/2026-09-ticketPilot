import { reportState } from "./state.js";

export interface FlowRecovery {
    isRequired(): Promise<boolean>;
    recover(): Promise<void>;
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
        if (recovered) throw new Error("排隊逾時再次出現，已達一次恢復上限，請人工檢查。");

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
            // 不需要恢復，就拋出錯誤
            if (!await recovery.isRequired()) throw error;
            await recoverOnce();
        }
    }
}
