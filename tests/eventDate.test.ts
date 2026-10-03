import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { parseEventDate, verifyEventDate } from "../src/platforms/klook/eventDate.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";

test("完整日期正規化：年月日、斜線、連字號、句點、空白與全形", () => {
    for (const text of ['2026年11月15日', '2026 年 11 月 15 日（週日）', '2026/11/15（日）', '2026-11-15', '2026.11.15', '２０２６／１１／１５']) {
        assert.equal(parseEventDate(text), '2026-11-15');
    }
    assert.equal(parseEventDate('2028/2/29'), '2028-02-29');
});

test("拒絕不存在、缺年份、日月歧義、混用分隔符與區間，不取子字串", () => {
    for (const text of ['2026/2/29', '2026/2/30', '2026/13/1', '2026/0/15', '2026/11/0', '0000/11/15']) {
        assert.throws(() => parseEventDate(text), /日期不存在/);
    }
    for (const text of ['11/15', '11/12/2026', '2026/11-15', '12026/11/15', '2026/11/150', '2026/11/15-16', '2026/11/15、2026/11/16', '票價2026 11 15', '2026/11/15開賣']) {
        assert.throws(() => parseEventDate(text), /格式不支援或缺少年份/);
    }
});

test("只核對可見演出欄位：延遲載入、兩場實際段落；錯誤、隱藏、售票取票與衝突皆拒絕", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        for (const row of ['• 時間｜2026/11/15（日）', '💋 活動日期｜2026 年 11 月 15 日（日）']) {
            await page.setContent(`<div id="ticket-info"><h1>演唱會</h1><p>${row}</p><p>• 演出時間｜17:00 開始</p><h2>售票資訊</h2><p>日期：2025/1/1</p></div>`);
            await verifyEventDate(page, '2026-11-15', 500);
        }
        await page.setContent('<div id="ticket-info"><h2>售票資訊</h2><h3>購買方式</h3><p>日期：2025/1/1</p><h2>活動資訊</h2><p>日期：2026/11/15</p></div>');
        await verifyEventDate(page, '2026-11-15', 500);
        await page.setContent('<div id="ticket-info"></div><script>setTimeout(()=>document.querySelector("#ticket-info").innerHTML="<p>日期：2026-11-15</p>",100)</script>');
        await verifyEventDate(page, '2026-11-15', 1000);
        for (const html of [
            '<p>演出日期：2026/11/15</p>',
            '<div id="ticket-info"><p>開賣日期：2026/11/15</p><p>取票日期：2026/11/15</p></div>',
            '<div id="ticket-info"><h2>售票資訊</h2><p>日期：2026/11/15</p></div>',
            '<div id="ticket-info"><h2>售票資訊</h2><h3>購買方式</h3><p>日期：2026/11/15</p></div>',
            '<div id="ticket-info"><p hidden>演出日期：2026/11/15</p></div>',
            '<div id="ticket-info"><p>日期：2025/11/15</p></div><p>2026年11月15日</p>',
            '<div id="ticket-info"><p>日期：2026/11/15</p><p>日期：2026/11/16</p></div>',
            '<div id="ticket-info"><p>日期：11/15</p></div>',
            '<div id="ticket-info"><p>日期：2026/02/30</p></div>',
            '<div id="ticket-info"><p>日期：2026/11/15</p></div><div id="ticket-info"><p>日期：2026/11/15</p></div>',
        ]) {
            await page.setContent(html);
            await assert.rejects(verifyEventDate(page, '2026-11-15', 250), PurchaseStop);
        }
    } finally { await browser.close(); }
});

test("容器與段落重建後重新讀取；不混用舊標題、只接受有效日期", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        for (const mode of ['container', 'rows', 'wrong', 'invalid']) {
            await page.setContent('<div id="ticket-info"><h2>售票資訊</h2><p>日期：2026/11/15</p></div>');
            // 控制更新發生在第一份快照讀取後，避免依賴偶然的 timer 競速。
            const locator = page.locator('#ticket-info').filter({ visible: true });
            const read = locator.evaluateAll.bind(locator);
            let reads = 0;
            locator.evaluateAll = (async (...args: Parameters<typeof locator.evaluateAll>) => {
                const snapshot = await read(...args);
                if (++reads === 1) {
                    await page.locator('#ticket-info').evaluate(el => el.remove());
                } else if (reads === 2) {
                    const date = mode === 'wrong' ? '2026/11/16' : mode === 'invalid' ? '2026/02/30' : '2026/11/15';
                    await page.evaluate(date => {
                        const container = document.createElement('div');
                        container.id = 'ticket-info';
                        container.innerHTML = `<h2>活動資訊</h2><p>日期：${date}</p>`;
                        document.body.append(container);
                    }, date);
                    if (mode === 'rows') {
                        await page.locator('#ticket-info').evaluate(el => { el.innerHTML = '<h2>演出資訊</h2><p>時間｜2026/11/15（日）</p>'; });
                    }
                }
                return snapshot;
            }) as typeof locator.evaluateAll;
            // 只攔截日期容器的讀取時點，DOM 讀取與解析仍執行正式程式。
            const observedPage = new Proxy(page, {
                get(target, key) {
                    if (key === 'locator') return () => locator;
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                },
            });
            // verifyEventDate 會 filter 一次，保持同一個已設觀察點的 locator。
            locator.filter = () => locator;
            const result = verifyEventDate(observedPage, '2026-11-15', 1500);
            if (mode === 'wrong') await assert.rejects(result, /日期不符/);
            else if (mode === 'invalid') await assert.rejects(result, /日期不存在/);
            else await result;
            assert.equal(reads, 3);
        }
    } finally { await browser.close(); }
});

test("容器持續缺少時依原期限停止；CSS 隱藏日期不可通過", async () => {
    const browser = await chromium.launch(); const page = await browser.newPage();
    try {
        for (const html of ['', '<div id="ticket-info"><div style="display:none"><p>日期：2026/11/15</p></div></div>', '<div id="ticket-info"><p style="visibility:hidden">日期：2026/11/15</p></div>']) {
            await page.setContent(html);
            const started = Date.now();
            await assert.rejects(verifyEventDate(page, '2026-11-15', 250), /未能讀取明確/);
            assert.ok(Date.now() - started < 1500, '不能改用 locator 預設長等待或每輪重設期限');
        }
    } finally { await browser.close(); }
});
