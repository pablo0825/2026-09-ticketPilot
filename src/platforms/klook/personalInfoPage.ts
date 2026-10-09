import type { Page } from "playwright";

export function isPersonalInfoPage(currentUrl: string | URL, eventUrl: string): boolean {
    const current = new URL(currentUrl);
    return current.origin === new URL(eventUrl).origin && current.pathname === "/zh-TW/event/payment/";
}

// 只辨識頁面到達，不填寫個資或點擊「前往付款」。
export async function waitForPersonalInfoPage(page: Page, eventUrl: string, timeout = 30_000): Promise<void> {
    await page.waitForURL(url => isPersonalInfoPage(url, eventUrl), {
        timeout,
        waitUntil: "domcontentloaded",
    });

    await page.getByRole("heading", { name: "聯絡資料", exact: true }).waitFor({ state: "visible", timeout });
    await page.getByRole("button", { name: "前往付款", exact: true }).waitFor({ state: "visible", timeout });

    if (!isPersonalInfoPage(page.url(), eventUrl)) {
        throw new Error("頁面已離開填寫資料流程，請人工檢查。");
    }
}
