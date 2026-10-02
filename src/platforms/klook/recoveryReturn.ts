import type { Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";
import { isEventPageReady } from "./eventPage.js";

// 返回階段最多等 timeout；接續排隊後由排隊模組自己的固定期限等待就緒。
// 排隊恢復不傳入接續處理器，因此不會遞迴或再次按 OK。
export async function waitForRecoveryReturn(page: Page, eventUrl: string, timeout: number,
    failureMessage: string, returnQueueRecovery?: FlowRecovery): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isEventPageReady(page, eventUrl)) return;
        if (returnQueueRecovery && await returnQueueRecovery.isRequired()) {
            log("本次恢復途中出現排隊逾期：接續處理一次，仍屬同一次購票恢復。");
            await returnQueueRecovery.recover();
            if (!await isEventPageReady(page, eventUrl)) throw new Error(failureMessage);
            return;
        }
        await page.waitForTimeout(200);
    }
    throw new Error(failureMessage);
}
