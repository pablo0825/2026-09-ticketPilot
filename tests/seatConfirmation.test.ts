import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { KlookSeatSelector } from '../src/platforms/klook/seatSelector.js';
import { waitForPersonalInfoPage } from '../src/platforms/klook/personalInfoPage.js';

const target = { date: '2026-10-03', time: '12:00', area: 'A區', quantity: 1, adjacent: false };
const allocation = { kind: 'reserved' as const, seats: [{ section: 'A2', row: '4', number: '17' }] };
const eventUrl = 'https://www.klook.com/zh-TW/event-detail/test/';
const checkoutUrl = 'https://www.klook.com/zh-TW/event/payment/?shoppingcart_guid=test';
function fixture(number = '17', time = '12:00', disabled = false) {
    return `<div class="main_right-ZMnX67"><div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午${time}</span></div><div>00:06</div>
    <div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div>
    <div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div>
    <div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>${number}</ins></span></div></div>
    <div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$4880</div>
    <button ${disabled ? 'disabled' : ''} onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks || 0)+1)">確認</button>
    </div></div>`;
}

test('確認前重新核對：座位改變、場次不符、按鈕停用時不點擊；成功只按一次', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const [html, error] of [
            [fixture() + '<div>未於時限內確認，票券預留失敗</div>', /預留已到期/],
            [fixture('18'), /配位結果已改變/],
            [fixture().replace('NT$4,880', 'NT$5,000'), /單價不符/],
            [fixture('17', '06:00'), /時間不符/],
            [fixture('17', '12:00', true), /無法操作/],
        ] as const) {
            await page.setContent(html);
            await assert.rejects(new KlookSeatSelector(page, 4880, 800).confirmVerifiedSeats(target, allocation), error);
            assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
        }
        await page.setContent(fixture());
        await new KlookSeatSelector(page, 4880, 800).confirmVerifiedSeats(target, allocation);
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
        await new KlookSeatSelector(page, 4880, 800).confirmVerifiedSeats(target, allocation);
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

test('場次只讀唯一可見欄位：錯年、缺年、隱藏或重複時不確認，其他正確日期不能掩蓋', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const html of [
            fixture().replace('2026年', '2027年').replace('</button>', '</button><p>2026年10月3日 週六 下午12:00</p>'),
            fixture().replace('2026年', ''),
            fixture().replace('<span>2026', '<span hidden>2026'),
            fixture().replace('<span>2026', '<span style="opacity:0">2026'),
            fixture().replace('</span></div>', '</span><span>2026年10月3日 週六 下午12:00</span></div>'),
            fixture().replace('下午12:00', '下午12:00 附加日期'),
        ]) {
            await page.setContent(html);
            await assert.rejects(new KlookSeatSelector(page, 4880, 500).confirmVerifiedSeats(target, allocation));
            assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
        }
    } finally { await browser.close(); }
});

test('配位核對後年份改變，確認前重驗並停止', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.setContent(`<div id="ticket-options"><button onclick="document.querySelector('.main_right-ZMnX67').hidden=false">下一步</button></div>${fixture().replace('class="main_right-ZMnX67"', 'class="main_right-ZMnX67" hidden')}`);
        const selector = new KlookSeatSelector(page, 4880, 1000);
        const verified = await selector.openAndVerify(target);
        await page.locator('.pc_header_center-mSlDdM > span').evaluate(element => {
            element.textContent = '2027年10月3日 週六 下午12:00';
        });
        await assert.rejects(selector.confirmVerifiedSeats(target, verified), /日期不符/);
        assert.equal(await page.locator('body').getAttribute('data-clicks'), null);
    } finally { await browser.close(); }
});
