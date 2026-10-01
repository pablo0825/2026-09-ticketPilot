import type { Page } from "playwright";

// 只辨識頁面到達，不填寫個資或點擊「前往付款」。
export async function waitForPersonalInfoPage(page: Page, eventUrl: string, timeout = 30_000): Promise<void> {
    const origin = new URL(eventUrl).origin;
    await page.waitForURL(url => url.origin === origin && url.pathname === "/zh-TW/event/payment/", {
        timeout,
        waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "聯絡資料", exact: true }).waitFor({ state: "visible", timeout });
    await page.getByRole("button", { name: "前往付款", exact: true }).waitFor({ state: "visible", timeout });
    const current = new URL(page.url());
    if (current.origin !== origin || current.pathname !== "/zh-TW/event/payment/") {
        throw new Error("頁面已離開填寫資料流程，請人工檢查。");
    }
}
