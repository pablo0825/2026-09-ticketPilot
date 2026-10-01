import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { KlookSeatRecovery } from "../src/platforms/klook/seatRecovery.js";
import { KlookSeatSelector } from "../src/platforms/klook/seatSelector.js";
import { KlookTicketSelector } from "../src/platforms/klook/ticketSelector.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/test/";
const target = { date: "2026-10-03", time: "12:00", area: "A區", quantity: 1, adjacent: false };
const expiry = '未於時限內確認，票券預留失敗';
const modal = (action = "document.body.dataset.ok=String(Number(document.body.dataset.ok || 0)+1)") =>
    `<div class="klk-modal-alert"><p>${expiry}</p><button onclick="${action}">OK</button></div>`;
const panel = (number = '17') => `<div class="main_right-ZMnX67">2026年10月3日 週六 下午12:00
<div>00:00</div><div class="seat_list-BhwLqz">已選1個座位
<div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div>
<div class="list_item-jYRAN7"><ins>A1</ins><ins>10</ins><ins>${number}</ins></div>
<div class="con_seats-a3N26U">共計1個座位</div></div>
<button onclick="document.body.dataset.confirm=String(Number(document.body.dataset.confirm || 0)+1)">確認</button></div>`;
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh active-vB3nra">10月3日(週六)</div><button>重新整理</button><button>下一步</button></div>';
function fakeRecovery() {
    return { expired: false, count: 0,
        async isRequired() { return this.expired; },
        async recover() { this.count++; this.expired = false; },
    };
}

test("選位恢復限定原活動與唯一過期彈窗；錯頁、歧義、其他失敗或0座位不恢復", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.fulfill({ body: tickets + panel() + modal(), contentType: 'text/html; charset=utf-8' }));
        const recovery = new KlookSeatRecovery(page, eventUrl, 250);
        for (const url of ['https://www.klook.com/zh-TW/event/payment/', 'https://example.test/zh-TW/event-detail/test/', eventUrl + 'other/']) {
            await page.goto(url);
            assert.equal(await recovery.isRequired(), false);
            await assert.rejects(recovery.recover(), /無法確認/);
        }
        await page.goto(eventUrl);
        for (const html of [tickets + modal(), tickets + panel().replace('已選1個', '已選0個'), tickets + panel() + modal().replace(expiry, '選位失敗，請重試')]) {
            await page.setContent(html);
            assert.equal(await recovery.isRequired(), false);
        }
        for (const html of [tickets + panel() + modal() + modal(), tickets + panel() + modal().replace('<button ', '<button disabled ')]) {
            await page.setContent(html);
            await assert.rejects(recovery.recover());
            assert.equal(await page.locator('body').getAttribute('data-ok'), null);
        }
        await page.setContent(tickets + panel() + modal());
        await assert.rejects(recovery.recover(), /未能恢復/);
        assert.equal(await page.locator('body').getAttribute('data-ok'), '1');
        assert.equal(await page.locator('body').getAttribute('data-confirm'), null);
        await page.setContent(panel() + modal().replace('class="klk-modal-alert"', 'class="klk-modal-alert" hidden'));
        await new KlookSeatSelector(page, 1000).confirmVerifiedSeats(target, [
            { section: "A1", row: "10", number: "17" },
        ]);
        assert.equal(await page.locator('body').getAttribute('data-confirm'), '1');
        assert.equal(await page.locator('body').getAttribute('data-ok'), null);
    } finally { await browser.close(); }
});

test("確認前過期：OK 返回保留選項，重新核對票券並取得新座位，才確認一次", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        const group = (name: string, value: string) => `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div class="spec-LwNjSh active-vB3nra">${value}</div></div>`;
        const html = `<p>2026年10月3日</p><div id="ticket-options">
${group('日期', '10月3日(週六)')}${group('時間', '12:00')}${group('票種', 'A區（NT$4,880）')}
<div class="eventUnit-kxDycC"><div class="counter-vVrWZ9"><div class="value-xWKzpL">1</div></div><div>最多4張</div></div>
<button>重新整理</button><button id="next">下一步</button></div>
<script>document.querySelector('#next').onclick=()=>{const n=Number(document.body.dataset.assignments||0)+1;document.body.dataset.assignments=String(n);document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(panel('__NUMBER__'))}.replace('__NUMBER__',String(16+n)));};</script>`;
        await page.route('**/*', route => route.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }));
        await page.goto(eventUrl);
        const selector = new KlookSeatSelector(page, 1000);
        let confirmations = 0;
        const checked: string[] = [];
        await prepareBooking({
            selectSeats: async () => {
                await new KlookTicketSelector(page, 1000).selectAndVerify(target);
                return selector.openAndVerify(target);
            },
            confirmSeats: async seats => {
                if (++confirmations === 1) {
                    await page.locator('body').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
                        modal("document.body.dataset.ok=String(Number(document.body.dataset.ok||0)+1);document.querySelector('.main_right-ZMnX67').remove();this.parentElement.remove()"));
                }
                await selector.confirmVerifiedSeats(target, seats);
            },
            prepareContact: async seats => { checked.push(seats[0]!.number); },
        }, fakeRecovery(), fakeRecovery(), new KlookSeatRecovery(page, eventUrl, 1000));
        assert.deepEqual(checked, ['18']);
        assert.equal(await page.locator('body').getAttribute('data-assignments'), '2');
        assert.equal(await page.locator('body').getAttribute('data-confirm'), '1');
        assert.equal(await page.locator('body').getAttribute('data-ok'), '1');
        assert.equal(await page.locator('.value-xWKzpL').innerText(), '1');
    } finally { await browser.close(); }
});

test("確認已按下但導頁失敗時，即使出現過期提示也不重選或按OK", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.fulfill({ body: panel(), contentType: 'text/html; charset=utf-8' }));
        await page.goto(eventUrl);
        let selections = 0;
        await assert.rejects(prepareBooking({
            selectSeats: async () => { selections++; return [{ section: 'A1', row: '10', number: '17' }]; },
            confirmSeats: async seats => {
                await new KlookSeatSelector(page, 500).confirmVerifiedSeats(target, seats);
                await page.locator('body').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html), modal());
                throw new Error('確認已送出，導頁結果未知');
            },
            prepareContact: async () => assert.fail('不應進入個資階段'),
        }, fakeRecovery(), fakeRecovery(), new KlookSeatRecovery(page, eventUrl, 500)), /導頁結果未知/);
        assert.equal(selections, 1);
        assert.equal(await page.locator('body').getAttribute('data-confirm'), '1');
        assert.equal(await page.locator('body').getAttribute('data-ok'), null);
    } finally { await browser.close(); }
});

test("三種恢復共用一次額度；選位與其他恢復前後排列、連續過期均不超限", async () => {
    for (const first of ['queue', 'seat', 'contact'] as const) {
        for (const second of ['queue', 'seat', 'contact'] as const) {
            const queue = fakeRecovery(), seat = fakeRecovery(), contact = fakeRecovery();
            const recoveries = { queue, seat, contact };
            recoveries[first].expired = first !== 'contact';
            let attempts = 0;
            await assert.rejects(prepareBooking({
                selectSeats: async () => {
                    attempts++;
                    if (first !== 'contact' || attempts > 1) {
                        recoveries[second].expired = true;
                        if (second !== 'contact') throw new Error('選票階段過期');
                    }
                },
                confirmSeats: async () => {},
                prepareContact: async () => { contact.expired = true; },
            }, queue, contact, seat), /一次恢復上限/);
            assert.equal(queue.count + seat.count + contact.count, 1);
        }
    }
});
