import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { KlookContactRecovery } from "../src/platforms/klook/expiryRecovery.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/test/";
const contactUrl = "https://www.klook.com/zh-TW/event/payment/?shoppingcart_guid=fixture";
const message = "未於時限內確認，票券預留失敗";
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh">10月3日(週六)</div><button>重新整理</button></div>';
const modal = (text = message, action = "document.body.dataset.confirmed='yes'") =>
    `<div class="klk-modal klk-modal-alert"><p>${text}</p><button onclick="${action}">確認</button></div>`;

function fakeRecovery() {
    return {
        expired: false,
        count: 0,
        async isRequired() { return this.expired; },
        async recover() { this.count++; this.expired = false; },
    };
}

test("個資逾期後重新取得座位；第二次逾期停止，且不提交", async () => {
    const queue = fakeRecovery();
    const contact = fakeRecovery();
    let selections = 0;
    const verified: number[] = [];
    await prepareBooking({
        selectSeats: async () => ++selections,
        confirmSeats: async () => {},
        prepareContact: async seat => {
            verified.push(seat);
            if (seat === 1) { contact.expired = true; throw new Error("表單被彈窗遮住"); }
        },
    }, queue, contact);
    assert.deepEqual(verified, [1, 2]);
    assert.equal(contact.count, 1);
    assert.equal(queue.count, 0);

    const repeated = fakeRecovery();
    let attempts = 0;
    await assert.rejects(prepareBooking({
        selectSeats: async () => ++attempts,
        confirmSeats: async () => {},
        // 即使正常回傳，也檢查最後一刻才出現的逾期提示。
        prepareContact: async () => { repeated.expired = true; },
    }, fakeRecovery(), repeated), /一次恢復上限/);
    assert.equal(repeated.count, 1);
    assert.equal(attempts, 2);
});

test("排隊和個資各一次，不論發生順序；再次個資逾期停止", async () => {
    for (const queueFirst of [true, false]) {
        const queue = fakeRecovery();
        const contact = fakeRecovery();
        queue.expired = queueFirst;
        let attempts = 0;
        await assert.rejects(prepareBooking({
            selectSeats: async () => {
                attempts++;
                if (!queueFirst && attempts === 2) { queue.expired = true; throw new Error("排隊過期"); }
            },
            confirmSeats: async () => {},
            prepareContact: async () => { contact.expired = true; throw new Error("個資過期"); },
        }, queue, contact), /一次恢復上限/);
        assert.equal(queue.count, 1);
        assert.equal(contact.count, 1);
    }
});

test("確認或導頁結果未知、一般表單錯誤不恢復；提交發生於恢復範圍外", async () => {
    const queue = fakeRecovery();
    const contact = fakeRecovery();
    let selections = 0;
    const unknown = new Error("座位確認結果未知");
    await assert.rejects(prepareBooking({
        selectSeats: async () => ++selections,
        confirmSeats: async () => { contact.expired = true; queue.expired = true; throw unknown; },
        prepareContact: async () => assert.fail("不應到個資階段"),
    }, queue, contact), error => error === unknown);
    assert.equal(selections, 1);
    assert.equal(queue.count + contact.count, 0);
    queue.expired = false; contact.expired = false;
    await assert.rejects(prepareBooking({
        selectSeats: async () => {}, confirmSeats: async () => {},
        prepareContact: async () => { throw new Error("摘要不符"); },
    }, queue, contact), /摘要不符/);
    assert.equal(queue.count + contact.count, 0);

    let submissions = 0;
    await assert.rejects((async () => {
        await prepareBooking({ selectSeats: async () => {}, confirmSeats: async () => {}, prepareContact: async () => {} }, queue, contact);
        submissions++;
        contact.expired = true;
        throw new Error("個資提交結果未知");
    })(), /個資提交結果未知/);
    assert.equal(submissions, 1);
    assert.equal(queue.count + contact.count, 0);
});

test("個資逾期只辨識指定頁面與唯一彈窗，不誤點其他確認", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ body: modal(), contentType: "text/html; charset=utf-8" }));
        const recovery = new KlookContactRecovery(page, eventUrl, 300);
        for (const url of [eventUrl, 'https://www.klook.com/zh-TW/order-checkout/', 'https://example.test/zh-TW/event/payment/']) {
            await page.goto(url);
            assert.equal(await recovery.isRequired(), false);
            await assert.rejects(recovery.recover(), /無法確認/);
            assert.equal(await page.locator('body').getAttribute('data-confirmed'), null);
        }
        await page.goto(contactUrl);
        await page.setContent(modal("其他錯誤"));
        assert.equal(await recovery.isRequired(), false);
        await page.setContent(modal() + modal());
        await assert.rejects(recovery.recover(), /唯一/);
        await page.setContent(modal().replace('<button ', '<button disabled '));
        await assert.rejects(recovery.recover(), /無法操作/);
        await page.setContent(modal());
        await assert.rejects(recovery.recover(), /未能恢復/);
        assert.equal(await page.locator('body').getAttribute('data-confirmed'), 'yes');
    } finally { await browser.close(); }
});

test("整合：個資到期確認一次，等待返回選項載入，再以新座位準備表單", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    let selections = 0;
    let clicks = 0;
    const prepared: number[] = [];
    await page.exposeFunction('recordExpiryConfirm', () => { clicks++; });
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body:
            route.request().url().startsWith(contactUrl)
                ? '<h2>聯絡資料</h2><button onclick="document.body.dataset.submitted=1">前往付款</button>'
                : `<div id="loading">載入中</div><script>setTimeout(() => {document.body.innerHTML=${JSON.stringify(tickets)};}, 150)</script>` }));
        await page.goto(eventUrl);
        await prepareBooking({
            selectSeats: async () => {
                if (selections > 0) assert.equal(await page.locator('.spec-LwNjSh').isVisible(), true);
                return ++selections;
            },
            confirmSeats: async () => { await page.goto(contactUrl); },
            prepareContact: async seat => {
                prepared.push(seat);
                if (seat === 1) {
                    await page.locator('body').evaluate((el, html) => el.insertAdjacentHTML('beforeend', html),
                        modal(message, `recordExpiryConfirm();location.href='${eventUrl}'`));
                    throw new Error('填寫期間過期');
                }
            },
        }, fakeRecovery(), new KlookContactRecovery(page, eventUrl, 2000));
        assert.deepEqual(prepared, [1, 2]);
        assert.equal(clicks, 1);
        assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
    } finally { await browser.close(); }
});
