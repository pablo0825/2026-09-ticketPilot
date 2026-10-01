import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { readBookingSummary, verifyBookingSummary, type BookingSummary } from '../src/platforms/klook/bookingSummary.js';
import { bookingExpectation as expected } from '../src/config/event.config.js';
const target = { date: '2026-10-03', time: '12:00', area: 'A區', quantity: 1, adjacent: false };
const seats = [{ section: 'A1', row: '4', number: '15' }];
const summary: BookingSummary = { eventName: expected.eventName, packageName: 'A區（NT$4,880）', dateTime: '2026-10-03 12:00:00', quantity: '1', seatLabels: ['A1區, 第4排, 15號座位'], total: 'NT$ 4,880' };

test('摘要逐項核對，錯誤場次／票種／價格／張數／座位均停止', () => {
    verifyBookingSummary(summary, target, seats, expected);
    for (const change of [
        { eventName: '別的活動' }, { dateTime: '2026-10-03 18:00:00' },
        { packageName: 'A區愛心席（NT$4,880）' }, { packageName: 'A區（NT$4,890）' },
        { total: 'NT$ 4,890' }, { total: 'NT$ 48,80' }, { quantity: '2' },
        { seatLabels: [] }, { seatLabels: ['A1區, 第4排, 16號座位'] },
        { seatLabels: ['不明座位'] }, { seatLabels: [...summary.seatLabels, ...summary.seatLabels] },
    ]) assert.throws(() => verifyBookingSummary({ ...summary, ...change }, target, seats, expected));
    assert.throws(() => verifyBookingSummary(summary, target, [], expected));
    assert.throws(() => verifyBookingSummary(summary, target, seats, { ...expected, unitPrice: NaN }));
});

const url = 'https://www.klook.com/zh-TW/event/payment/?shoppingcart_guid=test';
const eventUrl = 'https://www.klook.com/zh-TW/event-detail/test/';
const product = `<div class="product"><h2 class="product_name">${expected.eventName.replaceAll('<','&lt;')}</h2><p class="product_package_name">A區（NT$4,880）</p><div class="main"><div class="item"><span class="item_label">日期</span><p class="item_value">2026-10-03 12:00:00</p></div><div class="item"><span class="item_label">門票（不含全家取票手續費NT$30/每筆）</span><span class="item_value">1</span></div><div><div class="item"><span class="item_value">A1區, 第4排, 15號座位</span></div></div></div><footer><span class="item_value">NT$ 4,880</span></footer></div>`;

test('真實摘要结构：範圍限定、讀取後核對；缺欄、重複、過期彈窗不宣告成功', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.fulfill({contentType:'text/html; charset=utf-8',body:'<body></body>'}));
        await page.goto(url);
        await page.setContent('<input value="不應讀取"><div class="item_value">其他區塊</div>' + product + '<button onclick="document.body.dataset.paid=1">前往付款</button>');
        assert.deepEqual(await readBookingSummary(page, eventUrl), summary);
        verifyBookingSummary(await readBookingSummary(page, eventUrl), target, seats, expected);
        assert.equal(await page.locator('body').getAttribute('data-paid'), null);
        for (const html of [product + product, product.replace('class="product_package_name"', 'class="missing"'), product + '<div class="klk-modal">未於時限內確認，票券預留失敗</div>']) {
            await page.setContent(html);
            await assert.rejects(readBookingSummary(page, eventUrl));
        }
        await page.goto(eventUrl);
        await page.setContent(product);
        await assert.rejects(readBookingSummary(page, eventUrl), /不在預期/);
    } finally { await browser.close(); }
});
