import type { Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";

const selectors = {
    alert: ".klk-modal-alert",
    seatPanel: ".main_right-ZMnX67",
    tickets: "#ticket-options",
    option: ".spec-LwNjSh",
};

// 排隊、選位與個人資料過期返回後，共用相同的選票入口檢查。
export async function isEventPageReady(page: Page, eventUrl: string): Promise<boolean> {
    const expected = new URL(eventUrl);
    const current = new URL(page.url());
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) return false;
    if (await page.locator(selectors.alert).filter({ visible: true }).count() > 0) return false;
    if (await page.locator(selectors.seatPanel).filter({ visible: true }).count() > 0) return false;

    // 這裡只確認選票入口恢復；完整日期、時間、票區仍由選票模組核對。
    const tickets = page.locator(selectors.tickets);
    if (!await tickets.isVisible()) return false;
    const options = tickets.locator(selectors.option);
    if (await options.count() === 0 || !await options.first().isVisible()) return false;

    const refresh = tickets.getByRole("button", { name: "重新整理", exact: true });
    return await refresh.count() === 1 && await refresh.isVisible() && await refresh.isEnabled();
}

// 返回階段最多等 timeout；接續排隊後由排隊模組自己的固定期限等待就緒。
// 排隊恢復不傳入接續處理器，因此不會遞迴或再次按 OK。
export async function waitForEventPage(page: Page, eventUrl: string, timeout: number,
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
