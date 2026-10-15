import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
type RequestLog = { path: string; method: string; body: any }[];
const timeLabel = "開賣時間（台灣 UTC+8）";

async function fixture(
    work: (h: Harness, page: Page, record: any, requests: RequestLog) => Promise<void>,
    settings: unknown = apiActivity,
) {
    const h = await apiHarness();
    const browser = await chromium.launch();
    try {
        const record = await (await h.request("/api/activities", settings)).json();
        assert(record.id);
        const page = await browser.newPage({ timezoneId: "America/New_York" });
        page.setDefaultTimeout(7000);
        const requests: RequestLog = [];
        page.on("request", request =>
            requests.push({
                path: new URL(request.url()).pathname,
                method: request.method(),
                body: request.postDataJSON(),
            }),
        );
        await page.goto(h.url);
        await page.locator("#selectTicketPlus").click();
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        await review(page);
        await work(h, page, record, requests);
    } finally {
        await browser.close();
        await h.dispose();
    }
}

async function review(page: Page) {
    await page.getByRole("button", { name: "② 確認與開始", exact: true }).click();
    await page.getByRole("region", { name: "購票前確認" }).waitFor();
}

async function setTime(page: Page, time: string) {
    await page.getByRole("combobox", { name: /執行方式/ }).selectOption({ label: "指定開賣時間" });
    await page.getByLabel(timeLabel, { exact: true }).fill(time.endsWith(":00") ? time.slice(0, -3) : time);
}

async function save(page: Page) {
    const response = page.waitForResponse(
        response => response.request().method() === "PUT" && response.url().includes("/api/activities/"),
    );
    await page.getByRole("button", { name: "儲存開始設定", exact: true }).click();
    assert.equal((await response).status(), 200);
    await eventually(async () => assert(await page.getByRole("button", { name: "開始購票", exact: true }).isEnabled()));
}

function starts(requests: RequestLog) {
    return requests.filter(request => request.path === "/api/purchase" && request.method === "POST");
}

function taiwanTime(milliseconds: number) {
    return new Date(milliseconds + 8 * 3600_000).toISOString().slice(0, 19);
}

test("TicketPlus 排程 GUI：非台灣時區保存到秒，真 worker 到時間才選票並抵達資料頁", { timeout: 35_000 }, async () => {
    await fixture(async (h, page, record, requests) => {
        const time = taiwanTime(Date.now() + 12_000);
        await setTime(page, time);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        await save(page);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: time + "+08:00" });
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
        assert.equal((await h.counts()).counts.session, 0);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, saved.settings);
        await h.until(run => run?.status === "information-ready");
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁"));
        assert.equal((await h.counts()).counts.session, 1);
        assert.equal((await h.counts()).counts.submit, 1);
        assert.equal((await h.counts()).counts.information, 0);
        assert.equal(starts(requests).length, 1, "倒數結束不應送出第二次啟動");
    });
});

test("TicketPlus 排程 GUI：等待中停止，倒數及切步驟不重啟，執行占用禁止改時間", { timeout: 25_000 }, async () => {
    await fixture(async (h, page, _record, requests) => {
        await setTime(page, taiwanTime(Date.now() + 60_000));
        await save(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
        await review(page);
        assert(await page.getByRole("combobox", { name: /執行方式/ }).isDisabled());
        assert(await page.getByLabel(timeLabel, { exact: true }).isDisabled());
        await page.getByRole("button", { name: "③ 執行狀態", exact: true }).click();
        await page.getByRole("button", { name: "停止購票", exact: true }).click();
        await h.until(run => run?.status === "failed");
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /購票已停止/));
        assert.equal((await h.counts()).counts.session, 0);
        assert.equal((await h.counts()).counts.submit, 0);
        assert.equal(starts(requests).length, 1);
    });
});

test("TicketPlus 排程 GUI：活動草稿與時間草稿各自保存，不互相覆蓋，立即開始移除排程", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "2026-12-01T12:34:56");
        const dialog = page.waitForEvent("dialog");
        const leave = page.locator("#homeButton").click();
        await (await dialog).dismiss();
        await leave;
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
        await page.getByLabel("張數", { exact: true }).fill("1");
        await review(page);
        assert(await page.getByRole("button", { name: "儲存開始設定", exact: true }).isDisabled());
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
        assert.equal(await page.getByLabel("張數", { exact: true }).inputValue(), "1");
        await page.getByRole("button", { name: "儲存活動", exact: true }).click();
        await page.getByLabel(timeLabel, { exact: true }).waitFor();
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        let saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 1);
        assert.equal(saved.settings.saleSchedule, undefined, "儲存活動不可偷偷儲存時間草稿");
        await save(page);
        saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 1);
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00" });
        await page.locator("#homeButton").click();
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        await review(page);
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        await page.getByRole("combobox", { name: /執行方式/ }).selectOption({ label: "立即開始" });
        await save(page);
        saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.saleSchedule, undefined);
        assert.equal(saved.settings.targets[0].quantity, 1);
        assert.equal(starts(requests).length, 0);
    });
});

test("TicketPlus 排程 GUI：版本衝突保留時間草稿，不覆蓋別頁設定也不啟動", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "2026-12-01T12:34:56");
        const changed = await fetch(h.url + "/api/activities/" + record.id, {
            method: "PUT",
            headers: { ...h.headers, "X-Activity-Revision": record.updatedAt },
            body: JSON.stringify({ ...apiActivity, targets: [{ ...apiActivity.targets[0], quantity: 3 }] }),
        });
        assert.equal(changed.status, 200);
        const response = page.waitForResponse(response => response.request().method() === "PUT");
        await page.getByRole("button", { name: "儲存開始設定", exact: true }).click();
        const rejected = await response;
        assert.equal(rejected.status(), 400);
        assert.match(await rejected.text(), /其他分頁修改/);
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 3);
        assert.equal(saved.settings.saleSchedule, undefined);
        assert.equal(starts(requests).length, 0);
    });
});

test("TicketPlus 排程 GUI：舊提前刷新設定普通保存仍保留，明確改為僅等待才移除", async () => {
    const schedule = { saleAt: "2026-12-01T12:34:56+08:00", advanceSeconds: 2 };
    await fixture(
        async (h, page, record, requests) => {
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
            await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
            await page.getByLabel("張數", { exact: true }).fill("1");
            await page.getByRole("button", { name: "儲存活動", exact: true }).click();
            await page.getByRole("button", { name: "改為僅等待開賣", exact: true }).waitFor();
            let saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.deepEqual(saved.settings.saleSchedule, schedule);
            await page.getByRole("button", { name: "改為僅等待開賣", exact: true }).click();
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
            await save(page);
            saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.deepEqual(saved.settings.saleSchedule, { saleAt: schedule.saleAt });
            assert.equal(saved.settings.targets[0].quantity, 1);
            assert.equal(starts(requests).length, 0);
        },
        { ...apiActivity, saleSchedule: schedule },
    );
});

test("TicketPlus 排程 GUI：啟動結果不明的 pending 保留設定，不允許修改排程", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "2026-12-01T12:34:56");
        await save(page);
        await page.route("**/api/purchase", route =>
            route.request().method() === "POST" ? route.abort("failed") : route.continue(),
        );
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () =>
            assert(await page.evaluate(() => sessionStorage.getItem("ticketpilot-ticketplus-purchase-request"))),
        );
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /失敗|確認|連線|fetch/i));
        assert(await page.getByRole("combobox", { name: /執行方式/ }).isDisabled());
        assert(await page.getByLabel(timeLabel, { exact: true }).isDisabled());
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00" });
        assert.equal(starts(requests).length, 1);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 排程 GUI：倒數跨過零只更新文字，不自行啟動或登入", async () => {
    await fixture(async (h, page, _record, requests) => {
        const run: PurchaseSnapshot = {
            id: "schedule-countdown",
            requestId: "schedule-countdown",
            platform: "ticketplus",
            activityName: "倒數測試",
            status: "running",
            browserOpen: true,
            occupied: true,
            message: "",
            saleAt: new Date(Date.now() + 3000).toISOString(),
            canStop: true,
            events: [
                { sequence: 1, at: new Date().toISOString(), event: { type: "ticketplus", stage: "waiting-for-sale" } },
            ],
            historyTruncated: false,
        };
        await snapshotFeed(page, "/api/purchase/events", run);
        await page.route("**/api/purchase", route => route.fulfill({ json: run }));
        await page.goto(h.url);
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("body").innerText(), /距開賣 \d+ 秒/));
        await eventually(async () => assert.match(await page.locator("body").innerText(), /已到設定時間/));
        assert.equal(await page.locator("#status").innerText(), "等待開賣");
        assert.equal(requests.filter(request => request.method === "POST").length, 0);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 排程 GUI：空白時間保留草稿，不保存也不啟動", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "");
        await page.getByRole("button", { name: "儲存開始設定", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /時間|日期/));
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "");
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert.equal(starts(requests).length, 0);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.saleSchedule, undefined);
    });
});

test("TicketPlus 排程 GUI：保存成功後列表失敗仍接受新版本，下一次保存更新同一筆", async () => {
    await fixture(async (h, page, record, requests) => {
        await page.route("**/api/activities", route =>
            route.request().method() === "GET"
                ? route.fulfill({ status: 500, json: { error: "列表暫時無法讀取" } })
                : route.continue(),
        );
        await setTime(page, "2026-12-01T12:34:56");
        await save(page);
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /已儲存.*列表.*失敗/));
        await page.getByLabel(timeLabel, { exact: true }).fill("2026-12-02T12:34:57");
        await save(page);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-02T12:34:57+08:00" });
        const list = await (await h.request("/api/activities")).json();
        assert.equal(list.activities.length, 1);
        assert.equal(requests.filter(request => request.method === "PUT").length, 2);
        assert.equal(starts(requests).length, 0);
    });
});
