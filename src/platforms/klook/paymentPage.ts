import type { Page } from "playwright";

export class PaymentPageError extends Error {}

// 只辨識付款頁與金額，不選付款方式，也不按「確認付款」。
export async function waitForPaymentPage(page: Page, eventUrl: string, expectedTotal: number,
    timeout = 30_000): Promise<void> {
    let stage = "等待同站付款頁網址與訂單編號";
    try {
        const origin = new URL(eventUrl).origin;
        await page.waitForURL(url => url.origin === origin && url.pathname === "/zh-TW/order-checkout/" &&
            Boolean(url.searchParams.get("order_no")?.trim()), { timeout, waitUntil: "domcontentloaded" });
        stage = "等待唯一可見的確認付款按鈕";
        const confirm = page.getByRole("button", { name: "確認付款", exact: true }).filter({ visible: true });
        await confirm.waitFor({ state: "visible", timeout });
        stage = "等待可見的付款方式";
        const methods = page.locator(".payment_type-name").filter({ visible: true });
        await methods.first().waitFor({ state: "visible", timeout });
        stage = "等待唯一可見的付款金額";
        const amount = page.locator(".oc_submit_price").filter({ visible: true });
        await amount.waitFor({ state: "visible", timeout });
        const text = (await amount.innerText()).normalize("NFKC").replace(/\s/g, "");
        const match = text.match(/^NT\$(\d+|\d{1,3}(?:,\d{3})+)$/);
        if (!match || Number(match[1]!.replace(/,/g, "")) !== expectedTotal) {
            throw new PaymentPageError("付款頁金額不符或格式未知。");
        }
        stage = "提交後的最終付款頁核對";
        const current = new URL(page.url());
        if (current.origin !== origin || current.pathname !== "/zh-TW/order-checkout/" ||
            !current.searchParams.get("order_no")?.trim()) {
            throw new PaymentPageError("核對期間已離開預期付款頁，或缺少訂單編號。");
        }
        if (await confirm.count() !== 1) throw new PaymentPageError("可見的確認付款按鈕不唯一或已消失。");
        if (!await confirm.isEnabled()) throw new PaymentPageError("確認付款按鈕目前停用。");
        if (await methods.count() === 0) throw new PaymentPageError("可見的付款方式已消失。");
        if (await page.locator('.klk-modal, .klk_c_dialog').filter({ visible: true }).count() > 0) {
            throw new PaymentPageError("付款頁有可見彈窗，請人工檢查。");
        }
    } catch (error) {
        if (error instanceof PaymentPageError) throw error;
        // 原始 Playwright 錯誤可能帶有訂單網址或頁面內容，只回報固定階段。
        throw new PaymentPageError(`${stage}失敗（逾時、元素不唯一或頁面已變動），請人工檢查。`);
    }
}
