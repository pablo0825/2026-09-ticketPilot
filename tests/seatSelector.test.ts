import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { KlookSeatSelector, getSeatResultMismatch, type SeatResult } from '../src/platforms/klook/seatSelector.js';

const target = { date: '2026-10-03', time: '12:00', area: 'A區', quantity: 1, adjacent: false };
const result: SeatResult = {
    text: '2026年10月3日 週六 下午12:00 已選1個座位',
    area: ' A區（NT$4,880） ', total: ' 共計1個座位 ',
    seats: [{ section: 'A2', row: '4', number: '17' }],
};

test('核對場次、票種、完整且不重複的座位；A2 不等同票種名稱', () => {
    assert.equal(getSeatResultMismatch(result, target), undefined);
    for (const change of [
        { text: result.text.replace('2026年', '2027年') },
        { text: result.text.replace('下午', '上午') },
        { text: result.text.replace('12:00', '18:00') },
        { area: 'A區愛心席（NT$4,880）' },
        { area: 'B區（NT$3,880）' },
        { total: '共計2個座位' }, { seats: [] },
        { seats: [{ section: 'A2', row: '4', number: '' }] },
    ]) assert.notEqual(getSeatResultMismatch({ ...result, ...change }, target), undefined);
    assert.notEqual(getSeatResultMismatch({ ...result, text: result.text.replace('已選1', '已選2'),
        total: '共計2個座位', seats: [...result.seats, ...result.seats] }, { ...target, quantity: 2 }), undefined);
});

test('等待彈窗內延遲配位；只按一次下一步且不按確認；不完整或停用時停止', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const ready of [true, false]) {
            await page.setContent(`<div id="ticket-options"><button onclick="openPanel()">下一步</button></div>
                <script>
                var clicks = 0;
                function openPanel() {
                    document.body.dataset.clicks = String(++clicks);
                    const panel = document.createElement('div');
                    panel.className = 'main_right-ZMnX67';
                    panel.textContent = '載入中'; document.body.append(panel);
                    setTimeout(() => { panel.innerHTML = '<p>2026年10月3日 週六 下午12:00</p><div class="seat_list-BhwLqz">已選1個座位<div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div><div class="list_item-jYRAN7"><ins>A2</ins><ins>4</ins><ins>17</ins></div><div class="con_seats-a3N26U">共計1個座位</div><button ${ready ? '' : 'disabled'} onclick="document.body.dataset.confirmed=1">確認</button></div>'; }, 300);
                }
                </script>`);
            const selector = new KlookSeatSelector(page, ready ? 2000 : 800);
            if (ready) assert.deepEqual(await selector.openAndVerify(target), result.seats);
            else await assert.rejects(selector.openAndVerify(target), /逾時/);
            assert.equal(await page.locator('body').getAttribute('data-clicks'), '1');
            assert.equal(await page.locator('body').getAttribute('data-confirmed'), null);
        }
    } finally { await browser.close(); }
});


test('不符原因可供診斷，上午十二點與下午十二點正確區分', () => {
    assert.match(getSeatResultMismatch({ ...result, text: result.text.replace('12:00', '06:00') }, target)!, /預期 12:00，實際 18:00/);
    assert.match(getSeatResultMismatch({ ...result, area: 'B區（NT$3,880）' }, target)!, /票種不符/);
    assert.match(getSeatResultMismatch({ ...result, seats: [{ section: 'A2', row: '', number: '17' }] }, target)!, /資料不完整/);
    assert.equal(getSeatResultMismatch({ ...result, text: result.text.replace('下午', '上午') }, { ...target, time: '00:00' }), undefined);
});

test('錯誤提示立即停止；不符保留原因；已有或重複彈窗不按下一步', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const panel = (text: string) => `<div class="main_right-ZMnX67">${text}</div>`;
    try {
        for (const existing of [panel('已有選位'), panel('第一個') + panel('第二個')]) {
            await page.setContent(`<div id="ticket-options"><button onclick="document.body.dataset.clicked=1">下一步</button></div>${existing}`);
            await assert.rejects(new KlookSeatSelector(page, 500).openAndVerify(target), /已有選位|不唯一/);
            assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
        }
        for (const text of ['選位失敗，請重試', '2026年10月3日 週六 下午06:00']) {
            await page.setContent(`<div id="ticket-options"><button onclick="document.querySelector('.main_right-ZMnX67').hidden=false; document.body.dataset.clicked=1">下一步</button></div><div class="main_right-ZMnX67" hidden>${text}</div>`);
            const expected = text.includes('失敗') ? /選位畫面顯示失敗或逾時/ : /等待配位結果逾時：時間不符：預期 12:00，實際 18:00/;
            await assert.rejects(new KlookSeatSelector(page, 500).openAndVerify(target), expected);
            assert.equal(await page.locator('body').getAttribute('data-clicked'), '1');
        }
    } finally { await browser.close(); }
});

test('場次後接倒數時保留文字邊界，不把 12:00 與 00:06 黏在一起', () => {
    const text = '2026年10月3日 週六 下午12:00\n00:06\n已選1個座位';
    assert.equal(getSeatResultMismatch({ ...result, text }, target), undefined);
    assert.notEqual(getSeatResultMismatch({ ...result, text: text.replace('下午12:00', '下午06:00') }, target), undefined);
});
