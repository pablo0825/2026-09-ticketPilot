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
        await assert.rejects(new KlookSeatSelector(page, 500).openAndVerify(eventConfig.targets[0]!), PurchaseStop);
        assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
        await captureSelectionDiagnostics(page, eventUrl, directory, "failure");
        const output = await readFile(join(directory, "failure.json"), "utf8");
        assert.equal(output.includes("SECRET"), false);
        assert.equal(output.includes("選位失敗，請重試"), true);
        await page.goto("https://www.klook.com/zh-TW/event/payment/");
        await assert.rejects(captureSelectionDiagnostics(page, eventUrl, directory, "failure"), /略過/);
    } finally {
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("停止診斷只採集一次失敗畫面，保存失敗也不拋錯或重試", async () => {
    const output = new PassThrough();
    let written = "";
    output.on("data", chunk => (written += String(chunk)));

    const labels: string[] = [];
    await collectStoppedDiagnostics(async label => {
        labels.push(label);
        throw new Error("disk error");
    }, output);
    assert.deepEqual(labels, ["failure"]);
    assert.match(written, /無法安全保存診斷/);

    const once: string[] = [];
    await collectStoppedDiagnostics(async label => {
        once.push(label);
    }, new PassThrough());
    assert.deepEqual(once, ["failure"]);
});

test("已觀察的 seatModal 外殼先出現時等待配位；內層未知提示仍停止", async () => {
    const browser = await chromium.launch();
    try {
        for (const hasUnknown of [false, true]) {
            const page = await browser.newPage();
            const result = `<div class="main_right-ZMnX67"><div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午12:00</span></div>
<div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">A區（NT$4,880）</div>
<div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>A1</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>15</ins></span></div></div><div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$4880</div></div><button>確認</button></div>`;
            await page.setContent(`<div id="ticket-options"><button onclick="document.body.dataset.next='1';document.querySelector('.seatModal').hidden=false;setTimeout(()=>document.querySelector('.seatModal').innerHTML=${JSON.stringify(result).replaceAll('"', "&quot;")},150)">下一步</button></div>
<div class="seatModal" role="dialog" hidden>載入中${hasUnknown ? '<div role="dialog">未知提示<button>OK</button></div>' : ""}</div>`);
            const promise = new KlookSeatSelector(page, 1000).openAndVerify(eventConfig.targets[0]!);
            if (hasUnknown) await assert.rejects(promise, PurchaseStop);
            else
                assert.deepEqual(await promise, {
                    kind: "reserved",
                    seats: [{ section: "A1", row: "4", number: "15" }],
                });
            assert.equal(await page.locator("body").getAttribute("data-next"), "1");
            await page.close();
        }
    } finally {
        await browser.close();
    }
});
