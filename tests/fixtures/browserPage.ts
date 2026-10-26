import { chromium } from "playwright";
import type { Page } from "playwright";

// 只共用瀏覽器生命週期；路由、頁面內容與預期結果仍由各情境決定。
export async function withBrowserPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        return await run(page);
    } finally {
        await browser.close();
    }
}
