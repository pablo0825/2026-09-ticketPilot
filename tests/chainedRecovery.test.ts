import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { SeatExpiredBeforeConfirmationError } from "../src/core/seatExpiry.js";
import { KlookContactRecovery } from "../src/platforms/klook/contactRecovery.js";
import { KlookSeatRecovery } from "../src/platforms/klook/seatRecovery.js";
import { KlookQueueRecovery } from "../src/platforms/klook/queueRecovery.js";
import { isEventPageReady } from "../src/platforms/klook/eventPage.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/test/";
const contactUrl = "https://www.klook.com/zh-TW/event/payment/";
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh">10月3日</div><button>重新整理</button></div>';
const queueMessage = '抱歉，時間到了！請返回並重新排隊';
const alert = (text: string, button: string, action: string) =>
    `<div class="klk-modal-alert"><p>${text}</p><button onclick="${action}">${button}</button></div>`;

test("個資／選位返回遇延遲排隊彈窗：各按一次，等待選項後以新座位重跑一次", async () => {
    const browser = await chromium.launch();
    try {
        for (const kind of ["contact", "seat"] as const) {
            const page = await browser.newPage();
            const clicks: string[] = [];
            await page.exposeFunction('record', (name: string) => clicks.push(name));
            const queueHtml = alert(queueMessage, 'OK', "window.finishQueue()");
            await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: !route.request().url().includes("returned=1") ? "" :
                `<script>
                window.finishQueue=async()=>{await window.record('queue');document.body.innerHTML='';setTimeout(()=>document.body.innerHTML=${JSON.stringify(tickets)},80);};
                setTimeout(()=>document.body.innerHTML=${JSON.stringify(queueHtml)},80);
                </script>` }));
            await page.goto(kind === 'contact' ? contactUrl : eventUrl);
            // 原始彈窗按鈕造成真正導頁；返回頁延遲出現排隊彈窗。
            const expiredHtml = (kind === 'seat' ? '<div class="main_right-ZMnX67">舊座位</div>' : '') +
                alert('未於時限內確認，票券預留失敗', kind === 'contact' ? '確認' : 'OK', 'window.returnEvent()');
            await page.setContent(kind === 'contact' ? expiredHtml : '');
            await page.evaluate(url => {
                (window as any).returnEvent = async () => { await (window as any).record('original'); location.href = url; };
            }, eventUrl + '?returned=1');
            let selections = 0;
            const prepared: number[] = [];
            await prepareBooking({
                selectSeats: async () => {
                    if (selections > 0) assert.equal(await isEventPageReady(page, eventUrl), true);
                    return ++selections;
                },
                confirmSeats: async seat => {
                    if (kind === 'seat' && seat === 1) {
                        await page.setContent(expiredHtml);
                        throw new SeatExpiredBeforeConfirmationError();
                    }
                },
                prepareContact: async seat => {
                    if (kind === 'contact' && seat === 1) throw new Error('個資已逾期');
                    prepared.push(seat);
                },
            }, new KlookQueueRecovery(page, eventUrl, 2000),
            new KlookContactRecovery(page, eventUrl, 2000), new KlookSeatRecovery(page, eventUrl, 2000));
            assert.deepEqual(clicks, ['original', 'queue']);
            assert.deepEqual(prepared, [2]);
            assert.equal(selections, 2);
            await page.close();
        }
    } finally { await browser.close(); }
});

test("返回途中排隊重複、未知彈窗、雙彈窗或錯活動時停止，不重按", async () => {
    const browser = await chromium.launch();
    try {
        for (const scenario of ['repeated', 'unknown', 'multiple', 'wrong-page', 'disabled']) {
            const page = await browser.newPage();
            let queueClicks = 0;
            await page.exposeFunction('countQueue', () => queueClicks++);
            let queueHtml = alert(queueMessage, 'OK', 'window.countQueue()');
            if (scenario === 'unknown') queueHtml = alert('未知錯誤', 'OK', 'window.countQueue()');
            if (scenario === 'multiple') queueHtml += alert('未知錯誤', 'OK', 'window.countQueue()');
            if (scenario === 'disabled') queueHtml = queueHtml.replace('<button ', '<button disabled ');
            await page.route('**/*', route => route.fulfill({ body: queueHtml, contentType: 'text/html; charset=utf-8' }));
            await page.goto(contactUrl);
            await page.setContent(alert('未於時限內確認，票券預留失敗', '確認', 'window.returnEvent()'));
            await page.evaluate(url => { (window as any).returnEvent = () => { location.href = url; }; },
                scenario === 'wrong-page' ? eventUrl + 'other/' : eventUrl);
            const contact = new KlookContactRecovery(page, eventUrl, 400);
            await assert.rejects(contact.recover(new KlookQueueRecovery(page, eventUrl, 400)));
            assert.equal(queueClicks, scenario === 'repeated' ? 1 : 0);
            await page.close();
        }
    } finally { await browser.close(); }
});

test("個資彈窗與未知彈窗同時存在時，不點原始確認", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route('**/*', route => route.fulfill({ body: '', contentType: 'text/html' }));
        await page.goto(contactUrl);
        await page.setContent(alert('未於時限內確認，票券預留失敗', '確認', "document.body.dataset.clicked='yes'") +
            alert('未知錯誤', 'OK', "document.body.dataset.clicked='yes'"));
        await assert.rejects(new KlookContactRecovery(page, eventUrl).recover(), /唯一/);
        assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
    } finally { await browser.close(); }
});
