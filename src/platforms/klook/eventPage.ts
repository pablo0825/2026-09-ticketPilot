import type { Page } from "playwright";

// 多個活動頁流程共用的選位結構。
export const seatPanelSelector = ".main_right-ZMnX67";
export const seatShellSelector = ".seatModal";

const selectors = {
    alert: ".klk-modal-alert",
    seatPanel: seatPanelSelector,
    tickets: "#ticket-options",
    option: ".spec-LwNjSh",
};

// 網址身分不等於入口已就緒；各操作仍須核對自己的 DOM 條件。
export function isEventPage(currentUrl: string | URL, eventUrl: string): boolean {
    const expected = new URL(eventUrl);
    const current = new URL(currentUrl);
    return current.origin === expected.origin && current.pathname === expected.pathname;
}

// 僅表示已有選位畫面，不代表座位資料完整或符合過期恢復資格。
export async function hasVisibleSeatScreen(page: Page): Promise<boolean> {
    return await page.locator(`${seatPanelSelector}, ${seatShellSelector}`).filter({ visible: true }).count() > 0;
}

// 排隊、選位與個人資料過期返回後，共用相同的選票入口檢查。
export async function isEventPageReady(page: Page, eventUrl: string): Promise<boolean> {
    if (!isEventPage(page.url(), eventUrl)) return false;
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
