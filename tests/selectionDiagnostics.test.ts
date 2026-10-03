import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { captureSelectionDiagnostics } from "../src/platforms/klook/selectionDiagnostics.js";
import { collectStoppedDiagnostics } from "../src/core/stoppedDiagnostics.js";
import { KlookSeatSelector } from "../src/platforms/klook/seatSelector.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/fixture/";

test("實站 adapter 路徑遇未支援彈窗零點擊，診斷不保存敏感值或任意文字", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketpilot-diagnostics-"));
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<body></body>" }));
        await page.goto(eventUrl + "?token=SECRET_QUERY");
        await page.setContent(`<div id="ticket-options"><button onclick="document.querySelector('.klk-modal-alert').hidden=false">下一步</button></div>
<div class="klk-modal-alert" hidden><p>選位失敗，請重試</p><p>SECRET_VISIBLE</p>
<input value="SECRET_INPUT"><span hidden>SECRET_HIDDEN</span><button onclick="document.body.dataset.clicked='yes'">OK</button></div>`);
        await assert.rejects(new KlookSeatSelector(page, 4880, 500).openAndVerify(eventConfig.targets[0]!), PurchaseStop);
        assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
        await captureSelectionDiagnostics(page, eventUrl, directory, "failure");
        const output = await readFile(join(directory, "failure.json"), "utf8");
        assert.equal(output.includes("SECRET"), false);
        assert.equal(output.includes("選位失敗，請重試"), true);
        await page.goto("https://www.klook.com/zh-TW/event/payment/");
        await assert.rejects(captureSelectionDiagnostics(page, eventUrl, directory, "returned"), /略過/);
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }); }
});

test("診斷 Enter 只採集返回，保存失敗也不重試購買；非互動只採一次", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    const labels: string[] = [];
    output.on("data", chunk => {
        if (String(chunk).includes("本次購買已終止")) setImmediate(() => input.write("\n"));
    });
    await collectStoppedDiagnostics(async label => {
        labels.push(label);
        if (label === "failure") throw new Error("disk error");
    }, input, output);
    assert.deepEqual(labels, ["failure", "returned"]);
    const once: string[] = [];
    await collectStoppedDiagnostics(async label => { once.push(label); }, new PassThrough(), new PassThrough());
    assert.deepEqual(once, ["failure"]);
});

test("已觀察的 seatModal 外殼先出現時等待配位；內層未知提示仍停止", async () => {
    const browser = await chromium.launch();
    try {
        for (const hasUnknown of [false, true]) {
            const page = await browser.newPage();
            const result = `<div class="main_right-ZMnX67">2026年10月3日 週六 下午12:00 已選1個座位
<div class="seat_list-BhwLqz"><div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div>
<div class="list_item-jYRAN7"><ins>A1</ins><ins>4</ins><ins>15</ins></div><div class="con_seats-a3N26U">共計1個座位</div></div><button>確認</button></div>`;
            await page.setContent(`<div id="ticket-options"><button onclick="document.body.dataset.next='1';document.querySelector('.seatModal').hidden=false;setTimeout(()=>document.querySelector('.seatModal').innerHTML=${JSON.stringify(result).replaceAll('"', '&quot;')},150)">下一步</button></div>
<div class="seatModal" role="dialog" hidden>載入中${hasUnknown ? '<div role="dialog">未知提示<button>OK</button></div>' : ''}</div>`);
            const promise = new KlookSeatSelector(page, 4880, 1000).openAndVerify(eventConfig.targets[0]!);
            if (hasUnknown) await assert.rejects(promise, PurchaseStop);
            else assert.deepEqual(await promise, [{ section: "A1", row: "4", number: "15" }]);
            assert.equal(await page.locator("body").getAttribute("data-next"), "1");
            await page.close();
        }
    } finally { await browser.close(); }
});
