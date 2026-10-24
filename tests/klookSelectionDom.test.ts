import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { readSelectionDom } from "../src/platforms/klook/selectionDom.js";

let browser: Browser;
before(async () => {
    browser = await chromium.launch();
});
after(async () => {
    await browser?.close();
});

// 依香港活動實站層級縮減；刻意不使用群組、標題與選項的外觀 class。
const group = (name: string, options: string[]) =>
    `<div><div>${name}</div><div>${options.map(text => `<div class="active-vB3nra"><div><div>${text}</div></div></div>`).join("")}</div></div>`;
const html = `<p>日期：2026-10-31；ZONEB HK$899</p><div id="ticket-options"><h2>票券選擇</h2><div>${group("日期", ["10月31日(週六)"])}${group("時間", ["18:00"])}${group("套餐類型", ["ZONEB HK$899"])}</div></div>`;

test("整頁內容向上辨識群組，不依賴外觀 class，也不收活動介紹", async () => {
    const page = await browser.newPage();
    try {
        for (const body of [html, html.replace(' id="ticket-options"', "")]) {
            await page.setContent(body);
            const result = await readSelectionDom(page);
            assert.equal(result.rootCount, 1);
            assert.equal(result.loading, false);
            assert.deepEqual(
                result.groups.map(g => [g.name, g.options.map(o => o.text)]),
                [
                    ["日期", ["10月31日(週六)"]],
                    ["時間", ["18:00"]],
                    ["票種", ["ZONEB HK$899"]],
                ],
            );
            assert.equal(result.groups[2]?.options[0]?.selected, true);
        }
    } finally {
        await page.close();
    }
});

test("保留缺資料與重複候選，停用同名項不隱藏；隱藏副本不參與", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(
            html.replace("</h2>", `</h2><div class="klk-loading">載入</div>`) + `<div hidden>${html}</div>`,
        );
        await page
            .locator("#ticket-options")
            .first()
            .evaluate(root => {
                const group = [...root.querySelectorAll("div")].find(e => e.textContent === "套餐類型")!.parentElement!;
                const option = group.lastElementChild!.firstElementChild!;
                const clone = option.cloneNode(true) as HTMLElement;
                clone.className = "disabled-ImixBj soldout-sBHQQa";
                option.after(clone);
            });
        const result = await readSelectionDom(page);
        assert.equal(result.rootCount, 1);
        assert.equal(result.loading, true);
        assert.equal(result.groups[2]?.options.length, 2);
        assert.equal(result.groups[2]?.options[1]?.disabled, true);
        await page.setContent(`<div id="ticket-options">${group("日期", [])}</div>`);
        assert.deepEqual((await readSelectionDom(page)).groups, [{ name: "日期", options: [] }]);
        await page.setContent(html + html);
        assert.equal((await readSelectionDom(page)).rootCount, 2);
    } finally {
        await page.close();
    }
});

test("群組混入說明時不把整列當選項；不把 body 當選票區", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(html);
        await page.getByText("套餐類型", { exact: true }).evaluate(heading => {
            heading.parentElement!.insertAdjacentHTML("beforeend", "<p>每人限購四張</p>");
        });
        assert.deepEqual((await readSelectionDom(page)).groups.find(g => g.name === "票種")?.options, []);
        await page.setContent(`<h2>票券選擇</h2>${group("日期", ["10月31日"])}`);
        assert.equal((await readSelectionDom(page)).rootCount, 0);
    } finally {
        await page.close();
    }
});
