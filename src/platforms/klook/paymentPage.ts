import type { Page } from "playwright";

export class PaymentPageError extends Error {}

// 只辨識付款頁，不選付款方式，也不按「確認付款」。
export async function waitForPaymentPage(page: Page, eventUrl: string, timeout = 30_000): Promise<void> {
    // stage 記錄目前做到哪一步；失敗時只回報這個步驟
    let stage = "等待同站付款頁網址與訂單編號";
    try {
        const origin = new URL(eventUrl).origin;
        await page.waitForURL(
            url =>
                url.origin === origin &&
                url.pathname === "/zh-TW/order-checkout/" &&
                Boolean(url.searchParams.get("order_no")?.trim()),
            { timeout, waitUntil: "domcontentloaded" },
        );

        stage = "等待唯一可見的確認付款按鈕";
        const confirm = page.getByRole("button", { name: "確認付款", exact: true }).filter({ visible: true });
        await confirm.waitFor({ state: "visible", timeout });

        stage = "等待可見的付款方式";
        const methods = page.locator(".payment_type-name").filter({ visible: true });
        await methods.first().waitFor({ state: "visible", timeout });

        stage = "提交後的最終付款頁核對";
        const current = new URL(page.url());
        if (
            current.origin !== origin ||
            current.pathname !== "/zh-TW/order-checkout/" ||
            !current.searchParams.get("order_no")?.trim()
        ) {
            throw new PaymentPageError("核對期間已離開預期付款頁，或缺少訂單編號。");
        }

        if ((await confirm.count()) !== 1) throw new PaymentPageError("可見的確認付款按鈕不唯一或已消失。");
        // 尚未填完付款資料時按鈕可能停用；此處只核對已到付款頁，不要求可付款。
        if ((await methods.count()) === 0) throw new PaymentPageError("可見的付款方式已消失。");
        if ((await page.locator(".klk-modal, .klk_c_dialog").filter({ visible: true }).count()) > 0) {
            throw new PaymentPageError("付款頁有可見彈窗，請人工檢查。");
        }
    } catch (error) {
        if (error instanceof PaymentPageError) throw error;
        // 原始 Playwright 錯誤可能帶有訂單網址或頁面內容，只回報固定階段。
        throw new PaymentPageError(`${stage}失敗（逾時、元素不唯一或頁面已變動），請人工檢查。`);
    }
}
