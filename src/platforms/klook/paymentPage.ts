import type { Page } from "playwright";

// 只辨識付款頁與金額，不選付款方式，也不按「確認付款」。
export async function waitForPaymentPage(page: Page, eventUrl: string, expectedTotal: number,
    timeout = 30_000): Promise<void> {
    const origin = new URL(eventUrl).origin;
    await page.waitForURL(url => url.origin === origin && url.pathname === "/zh-TW/order-checkout/" &&
        Boolean(url.searchParams.get("order_no")?.trim()), { timeout, waitUntil: "domcontentloaded" });
    const confirm = page.getByRole("button", { name: "確認付款", exact: true }).filter({ visible: true });
    await confirm.waitFor({ state: "visible", timeout });
    const methods = page.locator(".payment_type-name").filter({ visible: true });
    await methods.first().waitFor({ state: "visible", timeout });
    const amount = page.locator(".oc_submit_price").filter({ visible: true });
    await amount.waitFor({ state: "visible", timeout });
    const text = (await amount.innerText()).normalize("NFKC").replace(/\s/g, "");
    const match = text.match(/^NT\$(\d+|\d{1,3}(?:,\d{3})+)$/);
    if (!match || Number(match[1]!.replace(/,/g, "")) !== expectedTotal) {
        throw new Error("付款頁金額不符或格式未知。");
    }
    const current = new URL(page.url());
    if (current.origin !== origin || current.pathname !== "/zh-TW/order-checkout/" ||
        !current.searchParams.get("order_no")?.trim() || await confirm.count() !== 1 ||
        !await confirm.isEnabled() || await methods.count() === 0 ||
        await page.locator('.klk-modal, .klk_c_dialog').filter({ visible: true }).count() > 0) {
        throw new Error("付款頁尚未就緒或有彈窗，請人工檢查。");
    }
}
