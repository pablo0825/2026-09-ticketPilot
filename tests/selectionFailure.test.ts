import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { KlookSelectionFailure, SelectionFailure } from "../src/platforms/klook/selectionFailure.js";
import { KlookTargetAttempt } from "../src/platforms/klook/targetAttempt.js";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";

const url = "https://www.klook.com/zh-TW/event-detail/test/";
const modal = (message: string, button = "OK", action = "window.clicks=(window.clicks||0)+1;this.parentElement.remove()") =>
    `<div class="klk-modal-alert"><p>${message}</p><button onclick="${action}">${button}</button></div>`;
const ready = '<div id="ticket-options"><div class="spec-LwNjSh">option</div><button>重新整理</button></div>';

test("指定兩種失敗與三種確認按鈕只按一次；變動、重複、停用、錯頁不操作", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: ready }));
        await page.goto(url);
        for (const message of ["已經沒有票了", "選位失敗，請重試"]) {
            for (const button of ["OK", "確認", "確定"]) {
                await page.setContent(ready + modal(message, button));
                const failure = new KlookSelectionFailure(page, url, 400);
                await assert.rejects(failure.observe(), SelectionFailure);
                await failure.returnAfterFailure();
                await assert.rejects(failure.returnAfterFailure());
                assert.equal(await page.evaluate("window.clicks"), 1);
                await page.evaluate("window.clicks=0");
            }
        }
        for (const html of [modal("其他失敗"), modal("已經沒有票了") + modal("未於時限內確認，票券預留失敗"),
            modal("已經沒有票了").replace('<button ', '<button disabled '),
            modal("已經沒有票了").replace('</div>', '<button>OK</button></div>')]) {
            await page.setContent(ready + html);
            const failure = new KlookSelectionFailure(page, url, 200);
            try { await failure.observe(); } catch (error) { assert.ok(error instanceof SelectionFailure); }
            await assert.rejects(failure.returnAfterFailure());
            assert.equal(await page.evaluate("window.clicks"), 0);
        }
        await page.setContent(ready + modal("已經沒有票了"));
        const changed = new KlookSelectionFailure(page, url, 200);
        await assert.rejects(changed.observe(), SelectionFailure);
        await page.locator(".klk-modal-alert p").evaluate(el => { el.textContent = "選位失敗，請重試"; });
        await assert.rejects(changed.returnAfterFailure());
        await page.goto("https://www.klook.com/zh-TW/event/payment/");
        await page.setContent(ready + modal("已經沒有票了"));
        const wrongPage = new KlookSelectionFailure(page, url, 200);
        await wrongPage.observe();
        await assert.rejects(wrongPage.returnAfterFailure());
    } finally { await browser.close(); }
});

test("真實 adapter 接線：沿用 Klook 結構的本機 fixture，A 失敗延遲返回後選 B", async () => {
    // 容器取自既有 Klook 過期彈窗；無票彈窗內容及返回仍屬模擬，未經實站驗證。
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        const group = (name: string, options: string[]) => `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div>${options.map((text, i) => `<div class="spec-LwNjSh ${i === 0 ? 'active-vB3nra' : ''}" onclick="for(const el of this.parentElement.children)el.classList.remove('active-vB3nra');this.classList.add('active-vB3nra')">${text}</div>`).join('')}</div></div>`;
        const panel = '<div class="main_right-ZMnX67">2026年10月3日 週六 下午12:00 <div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">B區（NT$3,880）</div><div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>B1</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>15</ins></span></div></div><div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$3880</div></div><button>確認</button></div>';
        const failureHtml = modal("選位失敗，請重試", "OK", "window.dismissals=(window.dismissals||0)+1;setTimeout(()=>this.parentElement.remove(),150)");
        const html = `<div id="ticket-info"><p>活動日期｜2026年10月3日</p></div><div id="ticket-options">${group('日期',['10月3日(週六)'])}${group('時間',['12:00'])}${group('票種',['A區（NT$4,880）','B區（NT$3,880）'])}<div class="eventUnit-kxDycC"><div class="value-xWKzpL">1</div>最多4張</div><button>重新整理</button><button id="next">下一步</button></div><script>window.areas=[];document.querySelector('#next').onclick=()=>{const isA=[...document.querySelectorAll('.active-vB3nra')].some(el=>el.textContent.startsWith('A區'));areas.push(isA?'A':'B');document.body.insertAdjacentHTML('beforeend',isA?${JSON.stringify(failureHtml)}:${JSON.stringify(panel)});};</script>`;
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
        await page.goto(url);
        const config = { ...eventConfig, eventUrl: url, targets: [eventConfig.targets[0]!, {
            ...eventConfig.targets[0]!, area: "B區", expectation: { ...eventConfig.targets[0]!.expectation, unitPrice: 3880, totalPrice: 3880 },
        }] };
        const result = await new PriorityStrategy(config).select(new KlookTargetAttempt(page, url, 1000));
        assert.equal(result.target.area, "B區");
        assert.equal(result.target.expectation.totalPrice, 3880);
        assert.deepEqual(result.value.allocation, { kind: "reserved", seats: [{ section: "B1", row: "4", number: "15" }] });
        assert.deepEqual(await page.evaluate("window.areas"), ["A", "B"]);
        assert.equal(await page.evaluate("window.dismissals"), 1);
    } finally { await browser.close(); }
});

test("返回未完成、返程出現排隊提示不再點擊；既有舊提示不可當本次失敗", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: ready }));
        await page.goto(url);
        for (const action of ["window.clicks=1", "window.clicks=1;this.parentElement.querySelector('p').textContent='抱歉，時間到了！請返回並重新排隊'"]) {
            await page.setContent(ready + modal("已經沒有票了", "OK", action));
            const failure = new KlookSelectionFailure(page, url, 200);
            await assert.rejects(failure.assertNoExistingNotice());
            await assert.rejects(failure.observe(), SelectionFailure);
            await assert.rejects(failure.returnAfterFailure(), /未能確認/);
            assert.equal(await page.evaluate("window.clicks"), 1);
        }
    } finally { await browser.close(); }
});

test("選票前已知排隊與選位過期保留恢復通道；有座位與無票矛盾不關閉", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: ready }));
        await page.goto(url);
        const failure = new KlookSelectionFailure(page, url, 200);
        for (const html of [modal("抱歉，時間到了！請返回並重新排隊"),
            '<div class="main_right-ZMnX67">過期</div>' + modal("未於時限內確認，票券預留失敗")]) {
            await page.setContent(ready + html);
            await assert.rejects(failure.assertNoExistingNotice(), /交由既有恢復/);
        }
        await page.setContent(ready + '<div class="main_right-ZMnX67"><div class="list_item-jYRAN7">A1 4 15</div></div>' + modal("已經沒有票了"));
        await failure.observe();
        await assert.rejects(failure.returnAfterFailure(), /沒有本次/);
        assert.equal(await page.evaluate("window.clicks || 0"), 0);
    } finally { await browser.close(); }
});
