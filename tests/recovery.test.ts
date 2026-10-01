import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { runWithRecovery } from '../src/core/recovery.js';
import { KlookQueueRecovery } from '../src/platforms/klook/queueRecovery.js';

test('已知例外才恢復；共用一次上限；未知錯誤原樣拋出', async () => {
    let expired = true, recoveries = 0, attempts = 0;
    const recovery = { isRequired: async () => expired, recover: async () => { recoveries++; expired = false; } };
    assert.equal(await runWithRecovery(async () => ++attempts, recovery), 1);
    assert.equal(recoveries, 1);
    expired = false; recoveries = 0; attempts = 0;
    assert.equal(await runWithRecovery(async () => {
        if (++attempts === 1) { expired = true; throw new Error('操作失敗'); }
        return '成功';
    }, recovery), '成功');
    assert.equal(attempts, 2);
    assert.equal(recoveries, 1);
    expired = true; recoveries = 0;
    await assert.rejects(runWithRecovery(async () => { expired = true; throw new Error('再次過期'); }, recovery), /一次恢復上限/);
    assert.equal(recoveries, 1);
    expired = false;
    const unknown = new Error('未知故障');
    await assert.rejects(runWithRecovery(async () => { throw unknown; }, recovery), error => error === unknown);
});

const url = 'https://www.klook.com/zh-TW/event-detail/test/';
const message = '抱歉，時間到了！\n請返回並重新排隊';
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh">10月3日(週六)</div><button>重新整理</button><button disabled>下一步</button></div>';
const modal = (text: string, action: string) => `<div class="klk-modal-alert"><div style="white-space:pre-line">${text}</div><button onclick="${action}">OK</button></div>`;

test('真實彈窗結構：只點目標 OK，等待頁面恢復；其他彈窗、其他頁面不恢復', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: tickets }));
        await page.goto(url);
        const recovery = new KlookQueueRecovery(page, url, 500);
        await page.setContent(tickets + modal(message, "document.body.dataset.ok='1';this.parentElement.remove()") + modal('其他提示', "document.body.dataset.wrong='1'").replace('class="klk-modal-alert"', 'class="klk-modal-alert" hidden'));
        assert.equal(await recovery.isRequired(), true);
        await recovery.recover();
        assert.equal(await page.locator('body').getAttribute('data-ok'), '1');
        assert.equal(await page.locator('body').getAttribute('data-wrong'), null);
        assert.equal(await recovery.isRequired(), false);
        await page.setContent(tickets + modal('未於時限內確認，票券預留失敗', ''));
        assert.equal(await recovery.isRequired(), false);
        await page.setContent(tickets + modal(message, ''));
        await assert.rejects(recovery.recover(), /未能確認活動頁恢復/);
        await page.setContent(tickets + modal(message, '') + modal(message, ''));
        await assert.rejects(recovery.recover(), /唯一/);
        await page.goto('https://www.klook.com/zh-TW/event/payment/');
        await page.setContent(tickets + modal(message, ''));
        assert.equal(await recovery.isRequired(), false);
    } finally { await browser.close(); }
});

test('整合恢復：OK 觸發重新載入，等待延遲選項後才開始下一次流程', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let loads = 0;
    let attempts = 0;
    try {
        await page.route('**/*', async route => {
            if (route.request().url() !== url) return route.abort();
            loads++;
            const body = loads === 1
                ? tickets + modal(message, "sessionStorage.setItem('okClicks', String(Number(sessionStorage.getItem('okClicks') || 0) + 1));location.reload()")
                : `<div id="ticket-options"><button>重新整理</button></div>
                    <script>setTimeout(() => {
                        document.querySelector('#ticket-options').insertAdjacentHTML('afterbegin', '<div class="spec-LwNjSh">10月3日(週六)</div>');
                        document.body.dataset.ready = 'true';
                    }, 350);</script>`;
            await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
        });
        await page.goto(url);
        const result = await runWithRecovery(async () => {
            attempts++;
            assert.equal(await page.locator('body').getAttribute('data-ready'), 'true');
            return '選票入口已恢復';
        }, new KlookQueueRecovery(page, url, 3000));
        assert.equal(result, '選票入口已恢復');
        assert.equal(loads, 2);
        assert.equal(attempts, 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem('okClicks')), '1');
    } finally { await browser.close(); }
});
