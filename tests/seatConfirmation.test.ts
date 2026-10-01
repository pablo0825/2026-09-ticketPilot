import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { KlookSeatSelector } from '../src/platforms/klook/seatSelector.js';
import { waitForPersonalInfoPage } from '../src/platforms/klook/personalInfoPage.js';

const target = { date: '2026-10-03', time: '12:00', area: 'A區', quantity: 1, adjacent: false };
const seats = [{ section: 'A2', row: '4', number: '17' }];
const eventUrl = 'https://www.klook.com/zh-TW/event-detail/test/';
const checkoutUrl = 'https://www.klook.com/zh-TW/event/payment/?shoppingcart_guid=test';
function fixture(number = '17', time = '12:00', disabled = false) {
    return `<div class="main_right-ZMnX67">2026年10月3日 週六 下午${time}<div>00:06</div>
    <div class="seat_list-BhwLqz">已選1個座位
    <div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div>
    <div class="list_item-jYRAN7"><ins>A2</ins><ins>4</ins><ins>${number}</ins></div>
    <div class="con_seats-a3N26U">共計1個座位</div>
    <button ${disabled ? 'disabled' : ''} onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">確認</button>
    </div></div>`;
}

test('確認前重新核對：座位改變、場次不符、按鈕停用時不點擊；成功只按一次', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const [html, error] of [
            [fixture() + '<div>未於時限內確認，票券預留失敗</div>', /預留已到期/],
            [fixture('18'), /座位已改變/],
            [fixture('17', '06:00'), /時間不符/],
            [fixture('17', '12:00', true), /無法操作/],
        ] as const) {
            await page.setContent(html);
            await assert.rejects(new KlookSeatSelector(page, 800).confirmVerifiedSeats(target, seats), error);
            assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
        }
        await page.setContent(fixture());
        await new KlookSeatSelector(page, 800).confirmVerifiedSeats(target, seats);
        assert.equal(await page.locator('body').getAttribute('data-clicks'), '1');
    } finally { await browser.close(); }
});

test('確認後等待填寫資料頁：網址與表單都要符合，且不點付款', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        // 全部請求由本機攔截回應，不存取 Klook。
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body:
            route.request().url() === eventUrl
                ? fixture().replace('document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)', `location.href='${checkoutUrl}'`)
                : '<h2>聯絡資料</h2><input aria-label="名"><button onclick="document.body.dataset.paid=1">前往付款</button>' }));
        await page.goto(eventUrl);
        await new KlookSeatSelector(page, 800).confirmVerifiedSeats(target, seats);
        await waitForPersonalInfoPage(page, eventUrl, 800);
        assert.equal(await page.getByRole('textbox').inputValue(), '');
        assert.equal(await page.locator('body').getAttribute('data-paid'), null);
        await page.goto(eventUrl);
        await assert.rejects(waitForPersonalInfoPage(page, eventUrl, 300));
        await page.goto(checkoutUrl);
        await page.setContent('<h2>載入中</h2>');
        await assert.rejects(waitForPersonalInfoPage(page, eventUrl, 300));
        await page.goto('https://example.test/zh-TW/event/payment/');
        await assert.rejects(waitForPersonalInfoPage(page, eventUrl, 300));
    } finally { await browser.close(); }
});
