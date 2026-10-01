import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { KlookContactForm } from "../src/platforms/klook/contactForm.js";
import { waitForPaymentPage } from "../src/platforms/klook/paymentPage.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/test/";
const contactUrl = "https://www.klook.com/zh-TW/event/payment/";
const paymentUrl = "https://www.klook.com/zh-TW/order-checkout/?order_no=test";
const submitButton = '<button onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">前往付款</button>';
const payment = '<span class="payment_type-name">信用卡/記帳卡</span><span class="oc_submit_price">NT$ 4,880</span><button style="display:none">前往付款</button><button onclick="document.body.dataset.paid=1">確認付款</button>';

test("提交遇到錯頁、彈窗、欄位錯誤、重複或停用按鈕時不點擊", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ body: submitButton, contentType: "text/html; charset=utf-8" }));
        await page.goto(contactUrl);
        for (const html of [
            submitButton + '<div class="klk-modal">未於時限內確認，票券預留失敗</div>',
            submitButton + '<div class="klk-form-item-error">格式錯誤</div>',
            submitButton + submitButton,
            submitButton.replace('<button ', '<button disabled '),
        ]) {
            await page.setContent(html);
            await assert.rejects(new KlookContactForm(page, eventUrl, 300).submit(), /未提交/);
            assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
        }
        await page.goto("https://example.test/zh-TW/event/payment/");
        await assert.rejects(new KlookContactForm(page, eventUrl, 300).submit(), /未提交/);
        assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
    } finally { await browser.close(); }
});

test("提交一次抵達付款頁，忽略隱藏按鈕且不確認付款；未導頁時不重送", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    let contactClicks = 0;
    await page.exposeFunction("recordSubmit", () => { contactClicks += 1; });
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
            route.request().url() === contactUrl
                ? `<button style="display:none">前往付款</button><button onclick="recordSubmit();location.href='${paymentUrl}'">前往付款</button>`
                : payment }));
        await page.goto(contactUrl);
        await new KlookContactForm(page, eventUrl, 1000).submit();
        await waitForPaymentPage(page, eventUrl, 4880, 1000);
        assert.equal(contactClicks, 1);
        assert.equal(await page.locator("body").getAttribute("data-paid"), null);
        await page.goto(contactUrl);
        await page.setContent(submitButton);
        await new KlookContactForm(page, eventUrl, 500).submit();
        await assert.rejects(waitForPaymentPage(page, eventUrl, 4880, 200));
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
    } finally { await browser.close(); }
});

test("付款頁拒絕錯金額、缺少訂單編號、錯來源、彈窗及未完整載入", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ body: payment, contentType: "text/html; charset=utf-8" }));
        for (const url of [paymentUrl.replace("?order_no=test", ""), paymentUrl.replace("www.klook.com", "example.test")]) {
            await page.goto(url);
            await assert.rejects(waitForPaymentPage(page, eventUrl, 4880, 200));
        }
        await page.goto(paymentUrl);
        for (const html of [payment.replace("4,880", "3,880"), payment + '<div class="klk_c_dialog">已過期</div>',
            payment.replace('class="payment_type-name"', 'class="missing"'), payment + '<button>確認付款</button>']) {
            await page.setContent(html);
            await assert.rejects(waitForPaymentPage(page, eventUrl, 4880, 200));
            assert.equal(await page.locator("body").getAttribute("data-paid"), null);
        }
    } finally { await browser.close(); }
});

test("提交按鈕被遮擋而點擊逾時時，回報結果未知且不自行重送", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: submitButton + '<div id="overlay" style="position:fixed;inset:0;z-index:100"></div>',
        }));
        await page.goto(contactUrl);
        const form = new KlookContactForm(page, eventUrl, 300);
        await assert.rejects(form.submit(), /提交結果未知.*不會自動重送/);
        assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
        // 解除遮擋後也不應有尚在背景執行的點擊或重試。
        await page.locator("#overlay").evaluate(element => element.remove());
        await page.waitForTimeout(400);
        assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
    } finally { await browser.close(); }
});
