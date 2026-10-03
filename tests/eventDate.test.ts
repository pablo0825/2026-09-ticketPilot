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
