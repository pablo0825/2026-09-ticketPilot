import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
async function fixture(work: (h: Harness, page: Page, id: string) => Promise<void>) {
    const h = await apiHarness();
    const browser = await chromium.launch();
    try {
        const record = await (await h.request("/api/activities", apiActivity)).json();
        assert.equal(typeof record.id, "string");
        const page = await browser.newPage();
        await work(h, page, record.id);
    } finally {
        await browser.close();
        await h.dispose();
    }
}

const run = {
    id: "navigation-run",
    requestId: "navigation-request",
    platform: "ticketplus",
    activityName: apiActivity.eventName,
    status: "payment-ready",
    occupied: true,
    browserOpen: true,
    canCloseBrowser: true,
    events: [],
    historyTruncated: false,
};

test("活動列表直接開啟，不載入聯絡資料或提供 Klook 入口", async () => {
    await fixture(async (h, page) => {
        const contacts: string[] = [];
        page.on("request", request => {
            if (new URL(request.url()).pathname === "/api/contact") contacts.push(request.url());
        });
        await page.goto(h.url);
        await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        assert.equal(await page.locator("#selectKlook, #selectTicketPlus, #platformHome").count(), 0);
        assert.equal(await page.getByRole("heading", { name: "活動列表", exact: true }).count(), 1);
        assert.deepEqual(contacts, []);
    });
});

test("啟動請求處理期間禁止離開，返回列表不重送購票", async () => {
    await fixture(async (h, page, id) => {
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let starts = 0;
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            starts++;
            await gate;
            await route.fulfill({
                json: { ...run, activityId: id, requestId: route.request().postDataJSON().requestId },
            });
        });
        await page.goto(h.url);
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        await page.getByRole("button", { name: "確認與開始", exact: true }).click();
        await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        try {
            await eventually(async () => assert.equal(starts, 1));
            assert(await page.locator("#brandHome").isDisabled());
            assert(await page.locator("#homeButton").isDisabled());
        } finally {
            release();
        }
        await page.locator("#status").waitFor();
        await page.locator("#brandHome").click();
        await page.getByRole("heading", { name: "活動列表", exact: true }).waitFor();
        assert(await page.locator("#new").isDisabled());
        assert.equal(starts, 1);
    });
});

test("未知請求跨列表導覽仍保留，不保存也不建立新請求", async () => {
    await fixture(async (h, page, id) => {
        const key = "ticketpilot-ticketplus-purchase-request";
        const pending = JSON.stringify({ version: 1, requestId: "unknown-request", activityId: id, signature: "old" });
        await page.addInitScript(({ key, pending }) => sessionStorage.setItem(key, pending), { key, pending });
        let writes = 0;
        page.on("request", request => {
            if (["POST", "PUT", "DELETE"].includes(request.method())) writes++;
        });
        await page.goto(h.url);
        for (let count = 0; count < 2; count++) {
            await page.getByRole("button", { name: "編輯活動", exact: true }).click();
            await page.locator("#brandHome").click();
        }
        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /無法核對.*保留/));
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), key), pending);
        assert.equal(writes, 0);
    });
});

test("未知占用不標示為 TicketPlus，無對應活動仍可查看且持續接收狀態", async () => {
    await fixture(async (h, page) => {
        const external = { ...run, platform: null, status: "interrupted", canCloseBrowser: false };
        const feed = await snapshotFeed(page, "/api/purchase/events", external);
        await page.goto(h.url);
        await page.locator("#viewRun").click();
        assert.match(await page.locator("#logs").innerText(), /購票平台：未知/);
        await page.locator("#brandHome").click();
        assert(await page.locator("#new").isDisabled());
        feed.publish({ ...run, status: "unknown", occupied: false, browserOpen: false, canCloseBrowser: false });
        await page.locator("#viewRun").click();
        await eventually(async () => assert.match(await page.locator("#instruction").innerText(), /提交結果尚未確認/));
    });
});

test("關窗取消不送請求；活動狀態與獨立結果頁在關閉期間皆禁止離開", async () => {
    await fixture(async (h, page, id) => {
        let closes = 0;
        for (const activityId of [id, undefined]) {
            const current = { ...run, activityId };
            await snapshotFeed(page, "/api/purchase/events", current);
            await page.goto(h.url);
            await page.getByRole("button", { name: activityId ? "查看狀態" : "查看目前狀態", exact: true }).click();
            let release = () => {};
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            await page.route("**/api/purchase/close-browser", async route => {
                closes++;
                await gate;
                await route.fulfill({
                    json: { ...current, occupied: false, browserOpen: false, canCloseBrowser: false },
                });
            });
            const before = closes;
            page.once("dialog", async dialog => {
                assert.match(dialog.message(), /付款/);
                await dialog.dismiss();
            });
            await page.locator("#closeBrowser").click();
            assert.equal(closes, before);
            page.once("dialog", dialog => dialog.accept());
            await page.locator("#closeBrowser").click();
            try {
                await eventually(async () => assert.equal(closes, before + 1));
                assert(await page.locator("#brandHome").isDisabled());
            } finally {
                release();
            }
            await eventually(async () => assert(await page.locator("#brandHome").isEnabled()));
            await page.unroute("**/api/purchase/close-browser");
        }
    });
});

test("重啟讀取的終態仍有 browserOpen 時保留查看入口", async () => {
    await fixture(async (h, page) => {
        await snapshotFeed(page, "/api/purchase/events", { ...run, occupied: false });
        await page.goto(h.url);
        await page.locator("#viewRun").click();
        assert.equal(await page.locator("#status").innerText(), "已到付款頁");
        assert.match(await page.locator("#instruction").innerText(), /付款/);
    });
});
