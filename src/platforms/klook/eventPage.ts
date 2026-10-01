import type { Page } from "playwright";

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
