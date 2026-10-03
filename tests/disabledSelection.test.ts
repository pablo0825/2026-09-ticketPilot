import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { KlookTargetAttempt } from "../src/platforms/klook/targetAttempt.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";

const url = "https://www.klook.com/zh-TW/event-detail/test/";
const config = { ...eventConfig, eventUrl: url, targets: ["A區", "B區"].map((area, i) => ({
    ...eventConfig.targets[0]!, area, expectation: { eventName: "fixture", unitPrice: 4880 - i * 1000, totalPrice: 4880 - i * 1000 },
})) };
// 停用 class 取自斑恩活動實際 DOM；配位與事件以本機 fixture 模擬。
function fixture(allDisabled = false) {
    const group = (name: string, values: string[], states: string[]) => `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div>${values.map((value, i) => `<div class="spec-LwNjSh ${states[i]}" onclick="document.body.dataset.optionClicks=(document.body.dataset.optionClicks||'')+'${name}:${i};'; for(const el of this.parentElement.children) el.classList.remove('active-vB3nra'); this.classList.add('active-vB3nra')">${value}</div>`).join('')}</div></div>`;
    const panel = '<div class="main_right-ZMnX67"><div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午12:00</span></div> <div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">B區 NT$3880</div><div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>B1</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>15</ins></span></div></div><div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$3880</div></div><button onclick="document.body.dataset.confirmed=1">確認</button></div>';
    return `<div id="ticket-info"><p>活動日期｜2026年10月3日</p></div><div id="ticket-options">${group('日期', ['10月3日(週六)'], ['active-vB3nra'])}${group('時間', ['12:00'], ['active-vB3nra'])}${group('票種', ['A區 NT$4880', 'B區 NT$3880'], ['disabled-ImixBj', allDisabled ? 'disabled-ImixBj' : ''])}<div class="eventUnit-kxDycC"><div class="value-xWKzpL">1</div>最多4張</div><button>重新整理</button><button id="next">下一步</button></div><script>document.querySelector('#next').onclick=()=>{document.body.dataset.next=String(Number(document.body.dataset.next||0)+1);document.body.insertAdjacentHTML('beforeend',${JSON.stringify(panel)});};</script>`;
}

test("實際 adapter／本機 fixture：A 停用直接配 B，不點 A、不返回、不消耗額度", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    let recoveries = 0; let returns = 0;
    const recovery = { async isRequired() { return false; }, async recover() { recoveries++; } };
    try {
        await page.route('**/*', route => route.fulfill({ body: fixture(), contentType: 'text/html; charset=utf-8' }));
        await page.goto(url);
        const adapter = new KlookTargetAttempt(page, url, 500);
        adapter.returnAfterFailure = async () => { returns++; assert.fail('停用不應返回'); };
        const selected = await prepareBooking({
            selectSeats: () => new PriorityStrategy(config).select(adapter),
            async confirmSeats() {}, async prepareContact() {},
        }, recovery, recovery);
        assert.equal(selected.target.area, 'B區');
        assert.equal(selected.target.expectation.unitPrice, 3880);
        assert.equal(await page.locator('body').getAttribute('data-option-clicks'), '票種:1;');
        assert.equal(await page.locator('body').getAttribute('data-next'), '1');
        assert.equal(await page.locator('body').getAttribute('data-confirmed'), null);
        assert.equal(returns, 0); assert.equal(recoveries, 0);
    } finally { await browser.close(); }
});

test("全部停用即停止且不重啟順位；錯價、缺少、歧義與矛盾狀態不跳過", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.fulfill({ body: fixture(), contentType: 'text/html; charset=utf-8' }));
        await page.goto(url);
        await page.setContent(fixture(true));
        const strategy = new PriorityStrategy(config);
        const adapter = new KlookTargetAttempt(page, url, 300);
        await assert.rejects(strategy.select(adapter), /NO_TARGET_AVAILABLE/);
        assert.equal(await page.locator('body').getAttribute('data-option-clicks'), null);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
        await page.setContent(fixture());
        await assert.rejects(strategy.select(adapter), /NO_TARGET_AVAILABLE/);
        for (const html of [
            fixture().replace('A區 NT$4880', 'A區 NT$5000'),
            fixture().replace('A區 NT$4880', 'C區 NT$4880'),
            fixture().replace('A區 NT$4880', 'A區 NT$4880</div><div class="spec-LwNjSh disabled-ImixBj">A區 NT$4880'),
            fixture().replace('disabled-ImixBj', 'disabled-ImixBj active-vB3nra'),
            fixture() + '<div role="dialog">未知提示</div>',
            fixture() + '<div class="seatModal">載入中</div>',
            fixture().replace('active-vB3nra', ''),
        ]) {
            await page.setContent(html);
            // 日期沒有已選狀態時也禁止實際選中，用來驗證不可跳過核對。
            if (!html.includes('日期</div><div><div class="spec-LwNjSh active-vB3nra')) {
                await page.getByText('10月3日(週六)', { exact: true }).evaluate(el => el.removeAttribute('onclick'));
            }
            await assert.rejects(new PriorityStrategy(config).select(adapter));
            assert.equal(await page.locator('body').getAttribute('data-option-clicks'), null);
            assert.equal(await page.locator('body').getAttribute('data-next'), null);
        }
    } finally { await browser.close(); }
});

test("停用後的順位跨恢復保留；只扣真正的恢復額度", async () => {
    const strategy = new PriorityStrategy(config);
    const attempts: string[] = [];
    let expired = false; let count = 0;
    const queue = { async isRequired() { return expired; }, async recover() { count++; expired = false; } };
    const contact = { async isRequired() { return false; }, async recover() { assert.fail(); } };
    const selected = await prepareBooking({
        selectSeats: () => strategy.select({
            async attempt(target) {
                attempts.push(target.area);
                if (target.area === 'A區') return { status: 'unavailable', reason: 'disabled' };
                if (attempts.length === 2) { expired = true; throw new Error('queue expired'); }
                return { status: 'matched', value: true };
            },
            async returnAfterFailure() { assert.fail('停用不應返回'); },
        }),
        async confirmSeats() {}, async prepareContact() {},
    }, queue, contact);
    assert.deepEqual(attempts, ['A區', 'B區', 'B區']);
    assert.equal(selected.target.area, 'B區');
    assert.equal(count, 1);
});

test("調整數量時 B 才變停用：停止送出，不再嘗試 C", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        const html = fixture().replace('<div class="value-xWKzpL">1</div>', `<div class="counter-vVrWZ9"><div class="value-xWKzpL">0</div><div class="btn-vDH5IS" onclick="document.querySelector('.value-xWKzpL').textContent='1';for(const el of document.querySelectorAll('.spec-LwNjSh'))if(el.textContent==='B區 NT$3880')el.classList.add('disabled-ImixBj');"><i class="klk-icon-icon_other_plus_xs">+</i></div></div>`);
        await page.route('**/*', route => route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }));
        await page.goto(url);
        const attempts: string[] = [];
        const adapter = new KlookTargetAttempt(page, url, 500);
        const strategy = new PriorityStrategy({ ...config, targets: [...config.targets, { ...config.targets[1]!, area: 'C區' }] });
        await assert.rejects(strategy.select({
            async attempt(target) { attempts.push(target.area); return adapter.attempt(target); },
            async returnAfterFailure() { assert.fail('未送出不應返回'); },
        }), /操作後票種變為停用/);
        assert.deepEqual(attempts, ['A區', 'B區']);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await browser.close(); }
});

test("跳過停用票種後，下一順位仍須完整年份正確才能確認", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    let recoveries = 0;
    const recovery = { async isRequired() { return false; }, async recover() { recoveries++; } };
    try {
        await page.route('**/*', route => route.fulfill({ body: fixture(), contentType: 'text/html; charset=utf-8' }));
        for (const year of ['2026', '2027']) {
            await page.goto(url);
            await page.setContent(fixture().replace('2026年10月3日 週六', `${year}年10月3日 週六`));
            const result = prepareBooking({
                selectSeats: () => new PriorityStrategy(config).select(new KlookTargetAttempt(page, url, 500)),
                async confirmSeats({ target, value }) { await value.seatSelector.confirmVerifiedSeats(target, value.allocation); },
                async prepareContact() {},
            }, recovery, recovery);
            if (year === '2026') {
                assert.equal((await result).target.area, 'B區');
                assert.equal(await page.locator('body').getAttribute('data-confirmed'), '1');
            } else {
                await assert.rejects(result, /日期不符/);
                assert.equal(await page.locator('body').getAttribute('data-confirmed'), null);
            }
            assert.equal(await page.locator('body').getAttribute('data-next'), '1');
        }
        assert.equal(recoveries, 0);
    } finally { await browser.close(); }
});
