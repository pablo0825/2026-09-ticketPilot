import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { waitForTicketOptions } from "../src/platforms/klook/selectionPolling.js";
import { KlookTicketSelector } from "../src/platforms/klook/ticketSelector.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { SelectionExpiryNotice } from "../src/platforms/klook/notices.js";

let browser: Browser;
before(async () => {
    browser = await chromium.launch();
});
after(async () => {
    await browser?.close();
});
const group = (name: string, text: string) => `<div><div>${name}</div><div><div>${text}</div></div></div>`;
const groups = group("日期", "10月31日") + group("時間", "18:00") + group("票種", "A區");

test("收集期間零點擊，等三組完整且遮罩消失才返回", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(
            `<div id="ticket-options">${group("日期", "10月31日")}</div><script>document.onclick=()=>document.body.dataset.clicked='yes'</script>`,
        );
        let rounds = 0;
        const result = await waitForTicketOptions(
            page,
            async () => {
                if (++rounds === 3)
                    await page
                        .locator("#ticket-options")
                        .evaluate((el, html) => (el.innerHTML = html + '<div class="klk-loading">載入</div>'), groups);
                if (rounds === 5) await page.locator(".klk-loading").evaluate(el => el.remove());
            },
            1200,
        );
        assert.equal(rounds, 6);
        assert.equal(result.groups.length, 3);
        assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
    } finally {
        await page.close();
    }
});

test("每輪重讀，不能拼接不同輪資料；期限不因新資料重設", async () => {
    const page = await browser.newPage();
    try {
        let rounds = 0;
        const started = performance.now();
        await assert.rejects(
            waitForTicketOptions(
                page,
                async () => {
                    const html =
                        ++rounds % 4 < 2 ? group("日期", "10月31日") : group("時間", "18:00") + group("票種", "A區");
                    await page.setContent(`<div id="ticket-options">${html}</div>`);
                },
                450,
            ),
            /等待逾時/,
        );
        assert(performance.now() - started < 1800);
    } finally {
        await page.close();
    }
});

test("過期原樣傳出；初始不完整時正式 selector 不操作日期", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(
            `<div id="ticket-options">${group("日期", "10月31日")}</div><script>document.onclick=()=>document.body.dataset.clicked='yes'</script>`,
        );
        const expiry = new SelectionExpiryNotice("已過期");
        await assert.rejects(
            waitForTicketOptions(
                page,
                async () => {
                    throw expiry;
                },
                250,
            ),
            error => error === expiry,
        );
        await assert.rejects(
            new KlookTicketSelector(page, 250).selectAndVerify({
                date: "2026-10-31",
                time: "18:00",
                area: "A區",
                quantity: 1,
                adjacent: false,
            }),
            PurchaseStop,
        );
        assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
    } finally {
        await page.close();
    }
});
