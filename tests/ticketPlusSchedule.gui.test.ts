import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
type RequestLog = { path: string; method: string; body: any }[];
const timeLabel = "開賣時間（台灣 UTC+8）";
const advanceLabel = /提前刷新/;

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
    await page.getByRole("button", { name: "確認與開始", exact: true }).click();
    await page.getByRole("region", { name: "活動摘要" }).waitFor();
}

async function setTime(page: Page, time: string) {
    await page.getByRole("combobox", { name: /執行方式/ }).selectOption({ label: "指定開賣時間" });
    await page.getByLabel(timeLabel, { exact: true }).fill(time.endsWith(":00") ? time.slice(0, -3) : time);
}

async function start(page: Page) {
    await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
    await page.getByRole("button", { name: "開始購票", exact: true }).click();
}

async function rejectStart(page: Page) {
    await page.route("**/api/purchase", route =>
        route.request().method() === "POST"
            ? route.fulfill({ status: 400, json: { error: "測試明確拒絕啟動", notAccepted: true } })
            : route.continue(),
    );
}

async function rejectedSave(page: Page) {
    const response = page.waitForResponse(
        response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/purchase",
    );
    await start(page);
    assert.equal((await response).status(), 400);
    await eventually(async () => assert.match(await page.locator("#message").innerText(), /測試明確拒絕啟動/));
}

function starts(requests: RequestLog) {
    return requests.filter(request => request.path === "/api/purchase" && request.method === "POST");
}

function taiwanTime(milliseconds: number) {
    return new Date(milliseconds + 8 * 3600_000).toISOString().slice(0, 19);
}

test(
    "TicketPlus 排程 GUI：非台灣時區保存到秒與提前兩秒，真 worker 到時間才選票並抵達資料頁",
    { timeout: 35_000 },
    async () => {
        await fixture(async (h, page, record, requests) => {
            const time = taiwanTime(Date.now() + 12_000);
            await setTime(page, time);
            await page.getByRole("combobox", { name: advanceLabel }).selectOption("2");
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
            await start(page);
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            const saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.deepEqual(saved.settings.saleSchedule, { saleAt: time + "+08:00", advanceSeconds: 2 });
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            await h.login();
            await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
            assert.equal((await h.counts()).counts.session, 0);
            assert.deepEqual(starts(requests)[0]!.body.expectedActivity, saved.settings);
            await h.until(run => run?.status === "payment-ready");
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到付款頁"));
            assert.equal((await h.counts()).counts.session, 1);
            assert.equal((await h.counts()).counts.submit, 1);
            assert.equal((await h.counts()).counts.information, 1);
            const saleTime = Date.parse(time + "+08:00");
            const loads = (await h.counts()).timeline.filter((entry: { kind: string }) =>
                entry.kind.startsWith("/activity/"),
            );
            assert.equal(loads.length, 2);
            assert(
                loads[1].at >= saleTime - 2000 && loads[1].at < saleTime - 1000,
                "GUI 的兩秒設定必須抵達正式 runner",
            );
            assert.equal(starts(requests).length, 1, "倒數結束不應送出第二次啟動");
        });
    },
);

test("TicketPlus 排程 GUI：等待中停止，倒數及切步驟不重啟，執行占用禁止改時間", { timeout: 25_000 }, async () => {
    await fixture(async (h, page, _record, requests) => {
        await setTime(page, taiwanTime(Date.now() + 60_000));
        await start(page);
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
        await review(page);
        assert(await page.getByRole("combobox", { name: /執行方式/ }).isDisabled());
        assert(await page.getByLabel(timeLabel, { exact: true }).isDisabled());
        assert(await page.getByRole("combobox", { name: advanceLabel }).isDisabled());
        await page.getByRole("button", { name: "執行狀態", exact: true }).click();
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: "停止購票", exact: true }).click();
        await h.until(run => run?.status === "failed");
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /購票已停止/));
        assert.equal((await h.counts()).counts.session, 0);
        assert.equal((await h.counts()).counts.submit, 0);
        assert.equal(starts(requests).length, 1);
    });
});

test("TicketPlus 執行設定：活動與執行草稿隔離，活動保存保留原期限，修改需重新確認", async () => {
    await fixture(
        async (h, page, record, requests) => {
            await setTime(page, "2026-12-01T12:34:56");
            await page.getByLabel("最長執行時間（分鐘）").fill("15");
            const dialog = page.waitForEvent("dialog");
            const leave = page.locator("#homeButton").click();
            await (await dialog).dismiss();
            await leave;
            assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
            assert.equal(await page.getByLabel("最長執行時間（分鐘）").inputValue(), "15");
            const checkbox = page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ });
            await checkbox.check();
            await page.getByLabel("最長執行時間（分鐘）").fill("20");
            assert.equal(await checkbox.isChecked(), false);
            await page.getByRole("button", { name: "活動與順位", exact: true }).click();
            assert.equal(await page.getByLabel("最長執行時間（分鐘）").count(), 0);
            await page.getByLabel("張數", { exact: true }).fill("1");
            await review(page);
            await checkbox.check();
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
            await page.getByRole("button", { name: "活動與順位", exact: true }).click();
            await page.getByRole("button", { name: "下一步", exact: true }).click();
            await page.getByLabel(timeLabel, { exact: true }).waitFor();
            assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
            assert.equal(await page.getByLabel("最長執行時間（分鐘）").inputValue(), "20");
            let saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.equal(saved.settings.targets[0].quantity, 1);
            assert.equal(saved.settings.maxRunMinutes, 10);
            assert.equal(saved.settings.saleSchedule, undefined);
            await rejectStart(page);
            await rejectedSave(page);
            saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.equal(saved.settings.maxRunMinutes, 20);
            assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00" });
            assert.deepEqual(starts(requests)[0]!.body.expectedActivity, saved.settings);
            await page.locator("#homeButton").click();
            await page.getByRole("button", { name: "編輯活動", exact: true }).click();
            await review(page);
            assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
            assert.equal(await page.getByLabel("最長執行時間（分鐘）").inputValue(), "20");
        },
        { ...apiActivity, maxRunMinutes: 10 },
    );
});

test("TicketPlus 執行設定：真版本衝突保留草稿，不覆蓋別頁也不啟動", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "2026-12-01T12:34:56");
        const changed = await fetch(h.url + "/api/activities/" + record.id, {
            method: "PUT",
            headers: { ...h.headers, "X-Activity-Revision": record.updatedAt },
            body: JSON.stringify({ ...apiActivity, targets: [{ ...apiActivity.targets[0], quantity: 3 }] }),
        });
        assert.equal(changed.status, 200);
        await start(page);
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /其他分頁修改/));
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 3);
        assert.equal(saved.settings.saleSchedule, undefined);
        assert.equal(starts(requests).length, 0);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 執行設定：改為立即開始可清除開賣設定並保留有效期限，使用修改後候選啟動", async () => {
    await fixture(
        async (h, page, record, requests) => {
            const checkbox = page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ });
            await checkbox.check();
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isEnabled());
            await page.getByRole("combobox", { name: /執行方式/ }).selectOption("now");
            await page.getByLabel("最長執行時間（分鐘）").fill("10");
            await start(page);
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            const saved = await (await h.request("/api/activities/" + record.id)).json();
            assert.equal(saved.settings.saleSchedule, undefined);
            assert.equal(saved.settings.maxRunMinutes, 10);
            assert.deepEqual(starts(requests)[0]!.body.expectedActivity, saved.settings);
        },
        { ...apiActivity, maxRunMinutes: 10, saleSchedule: { saleAt: "2026-12-01T12:34:56+08:00", advanceSeconds: 2 } },
    );
});

test("TicketPlus 執行設定：真保存後回應遺失，不啟動且保留輸入", async () => {
    await fixture(async (h, page, record, requests) => {
        await page.route("**/api/activities/" + record.id, async route => {
            if (route.request().method() !== "PUT") return route.continue();
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            await route.abort("failed");
        });
        await setTime(page, "2026-12-01T12:34:56");
        await start(page);
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /失敗|連線|fetch/i));
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00" });
        assert.equal(await page.getByLabel(timeLabel, { exact: true }).inputValue(), "2026-12-01T12:34:56");
        assert.equal(starts(requests).length, 0);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 執行設定：啟動結果不明保留設定，重試不再次保存", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "2026-12-01T12:34:56");
        await page.route("**/api/purchase", route =>
            route.request().method() === "POST" ? route.abort("failed") : route.continue(),
        );
        await start(page);
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /失敗|確認|連線|fetch/i));
        assert(await page.getByRole("combobox", { name: /執行方式/ }).isDisabled());
        assert(await page.getByLabel(timeLabel, { exact: true }).isDisabled());
        assert(await page.getByRole("combobox", { name: advanceLabel }).isDisabled());
        assert(await page.getByLabel("最長執行時間（分鐘）").isDisabled());
        const first = starts(requests)[0]!.body.requestId;
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () => assert.equal(starts(requests).length, 2));
        assert.equal(starts(requests)[1]!.body.requestId, first);
        assert.equal(requests.filter(request => request.method === "PUT").length, 1);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00" });
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
        const feed = await snapshotFeed(page, "/api/purchase/events", run);
        await page.route("**/api/purchase", route => route.fulfill({ json: run }));
        await page.goto(h.url);
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("body").innerText(), /距開賣 \d+ 秒/));
        await eventually(async () => assert.match(await page.locator("body").innerText(), /已到設定時間/));
        assert.equal(await page.locator("#status").innerText(), "等待開賣");
        for (const [stage, title] of [
            ["refreshing-activity", "刷新活動頁"],
            ["waiting-for-availability", "等待目標場次開賣"],
            ["refreshing", "更新票數核對中"],
        ] as const) {
            run.events.push({
                sequence: run.events.length + 1,
                at: new Date().toISOString(),
                event: { type: "ticketplus", stage },
            });
            feed.publish(run);
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), title));
            assert(await page.getByRole("button", { name: "停止購票", exact: true }).isEnabled());
        }
        assert.equal(requests.filter(request => request.method === "POST").length, 0);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 執行設定：空白時間與非法期限不保存不啟動", async () => {
    await fixture(async (h, page, record, requests) => {
        await setTime(page, "");
        await page.getByLabel("最長執行時間（分鐘）", { exact: true }).fill("9");
        await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
        assert.equal(await page.getByText("開賣時間必須包含日期、秒與台灣時區 +08:00。", { exact: true }).count(), 0);
        assert.equal(await page.getByRole("alert").filter({ hasText: "請填寫有效的開賣日期與時間。" }).count(), 0);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await page.getByText("請填寫有效的開賣日期與時間。", { exact: true }).waitFor();
        assert(
            await page.getByLabel(timeLabel, { exact: true }).evaluate(element => element === document.activeElement),
        );
        await page.getByText("請填寫 10～1440 的整數分鐘。", { exact: true }).waitFor();
        await setTime(page, "2026-12-01T12:34:56");
        for (const value of ["", "9", "-1", "10.5", "1441"]) {
            await page.getByLabel("最長執行時間（分鐘）").fill(value);
            await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
            assert.equal(await page.getByText("請填寫 10～1440 的整數分鐘。", { exact: true }).count(), 0);
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await page.getByText("請填寫 10～1440 的整數分鐘。", { exact: true }).waitFor();
            assert(
                await page
                    .getByLabel("最長執行時間（分鐘）", { exact: true })
                    .evaluate(element => element === document.activeElement),
            );
        }
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert.equal(starts(requests).length, 0);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.saleSchedule, undefined);
    });
});

test("TicketPlus 執行設定：保存後啟動被拒仍接受新版本，再改立即開始可保存", async () => {
    await fixture(async (h, page, record, requests) => {
        await rejectStart(page);
        await setTime(page, "2026-12-01T12:34:56");
        await page.getByLabel("最長執行時間（分鐘）").fill("15");
        await rejectedSave(page);
        await page.getByRole("combobox", { name: /執行方式/ }).selectOption({ label: "立即開始" });
        assert.equal(await page.getByLabel("最長執行時間（分鐘）").inputValue(), "15");
        await rejectedSave(page);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.saleSchedule, undefined);
        assert.equal(saved.settings.maxRunMinutes, 15);
        assert.equal(requests.filter(request => request.method === "PUT").length, 2);
        assert.equal(starts(requests).length, 2);
        assert.deepEqual(starts(requests)[1]!.body.expectedActivity, saved.settings);
        assert.equal(await h.snapshot(), null);
    });
});

test("TicketPlus 執行設定：保存回應延遲時連點只保存一次並啟動一個真 worker", async () => {
    await fixture(async (h, page, record, requests) => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const reached = new Promise<void>(resolve => {
            entered = resolve;
        });
        await page.route("**/api/activities/" + record.id, async route => {
            if (route.request().method() !== "PUT") return route.continue();
            const response = await route.fetch();
            assert.equal(response.status(), 200);
            entered();
            await gate;
            await route.fulfill({ response });
        });
        try {
            await page.getByLabel("最長執行時間（分鐘）").fill("15");
            await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
            await page.getByRole("button", { name: "開始購票", exact: true }).evaluate(button => {
                (button as HTMLButtonElement).click();
                (button as HTMLButtonElement).click();
            });
            await reached;
            assert(await page.getByLabel("最長執行時間（分鐘）").isDisabled());
            assert.equal(starts(requests).length, 0);
            release();
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            assert.equal(requests.filter(request => request.method === "PUT").length, 1);
            assert.equal(starts(requests).length, 1);
            assert.equal(starts(requests)[0]!.body.expectedActivity.maxRunMinutes, 15);
            assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
        } finally {
            release();
        }
    });
});

test("TicketPlus 執行設定：已保存提前 2 秒可啟動且原設定不被改寫", async () => {
    const settings = {
        ...apiActivity,
        saleSchedule: { saleAt: "2026-12-01T12:34:56+08:00", advanceSeconds: 2 },
    };
    await fixture(async (h, page, record, requests) => {
        assert.equal(await page.getByRole("combobox", { name: advanceLabel }).inputValue(), "2");
        await start(page);
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings, settings);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, settings);
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
    }, settings);
});

test("TicketPlus 提前刷新 GUI：舊設定顯示預設一秒，讀取與啟動不補寫欄位", async () => {
    const settings = { ...apiActivity, saleSchedule: { saleAt: "2026-12-01T12:34:56+08:00" } };
    await fixture(async (h, page, record, requests) => {
        assert.equal(await page.getByRole("combobox", { name: advanceLabel }).inputValue(), "1");
        await rejectStart(page);
        await rejectedSave(page);
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, settings);
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings, settings);
    }, settings);
});

test("TicketPlus 提前刷新 GUI：修改取消確認、切步驟保留草稿、立即開始移除排程", async () => {
    await fixture(async (h, page, record, requests) => {
        assert.equal(await page.getByRole("combobox", { name: advanceLabel }).count(), 0);
        await setTime(page, "2026-12-01T12:34:56");
        const advance = page.getByRole("combobox", { name: advanceLabel });
        assert.equal(await advance.inputValue(), "1");
        const checkbox = page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ });
        await checkbox.check();
        await advance.selectOption("2");
        assert.equal(await checkbox.isChecked(), false);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        await review(page);
        assert.equal(await advance.inputValue(), "2");
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        await rejectStart(page);
        await rejectedSave(page);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity.saleSchedule, {
            saleAt: "2026-12-01T12:34:56+08:00",
            advanceSeconds: 2,
        });
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.deepEqual(saved.settings.saleSchedule, { saleAt: "2026-12-01T12:34:56+08:00", advanceSeconds: 2 });
        await page.getByRole("combobox", { name: /執行方式/ }).selectOption("now");
        assert.equal(await advance.count(), 0);
        await rejectedSave(page);
        assert.equal(starts(requests)[1]!.body.expectedActivity.saleSchedule, undefined);
        assert.equal((await (await h.request("/api/activities/" + record.id)).json()).settings.saleSchedule, undefined);
    });
});

test("TicketPlus 開賣欄位：寬畫面並排、窄畫面堆疊，移除策略說明", async () => {
    await fixture(async (_h, page) => {
        await page.getByRole("combobox", { name: /執行方式/ }).selectOption("scheduled");
        const time = page.getByLabel(timeLabel, { exact: true });
        const advance = page.getByRole("combobox", { name: advanceLabel });
        await page.setViewportSize({ width: 1280, height: 900 });
        const wideTime = await time.boundingBox();
        const wideAdvance = await advance.boundingBox();
        assert(wideTime && wideAdvance);
        assert(Math.abs(wideTime.y - wideAdvance.y) < 2);
        assert(Math.abs(wideTime.height - wideAdvance.height) < 1);
        assert(wideTime.x + wideTime.width < wideAdvance.x);
        assert(wideTime.width > wideAdvance.width * 1.5);

        await page.setViewportSize({ width: 390, height: 844 });
        const narrowTime = await time.boundingBox();
        const narrowAdvance = await advance.boundingBox();
        assert(narrowTime && narrowAdvance);
        assert(Math.abs(narrowTime.height - narrowAdvance.height) < 1);
        assert(narrowAdvance.y > narrowTime.y + narrowTime.height);
        assert(Math.abs(narrowTime.x - narrowAdvance.x) < 2);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.doesNotMatch(
            await page.getByRole("region", { name: "活動摘要" }).innerText(),
            /秒刷新活動頁|間隔至少 3 秒/,
        );
    });
});

test("TicketPlus 期限 GUI：舊缺值預填 10，唯讀不寫入，開始前保存並傳給真 worker", async () => {
    const { maxRunMinutes: _duration, ...legacy } = apiActivity;
    await fixture(async (h, page, record, requests) => {
        const input = page.getByLabel("最長執行時間（分鐘）", { exact: true });
        assert.equal(await input.inputValue(), "10");
        assert.equal(await input.getAttribute("min"), "10");
        assert.equal(await input.getAttribute("required"), "");
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert.deepEqual((await (await h.request("/api/activities/" + record.id)).json()).settings, legacy);
        await start(page);
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.maxRunMinutes, 10);
        assert.equal(requests.filter(request => request.method === "PUT").length, 1);
        assert.equal(starts(requests).length, 1);
        assert.equal(starts(requests)[0]!.body.expectedActivity.maxRunMinutes, 10);
        assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
    }, legacy);
});

test("TicketPlus 期限 GUI：舊 5 分鐘保留顯示但不能開始，改成 10 才保存及啟動", async () => {
    await fixture(
        async (h, page, record, requests) => {
            const input = page.getByLabel("最長執行時間（分鐘）", { exact: true });
            assert.equal(await input.inputValue(), "5");
            await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await page.getByText("請填寫 10～1440 的整數分鐘。", { exact: true }).waitFor();
            assert(await input.evaluate(element => element === document.activeElement));
            assert.equal(requests.filter(request => request.method === "PUT").length, 0);
            assert.equal(starts(requests).length, 0);
            assert.equal((await (await h.request("/api/activities/" + record.id)).json()).settings.maxRunMinutes, 5);
            await input.fill("10");
            await start(page);
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            assert.equal(starts(requests)[0]!.body.expectedActivity.maxRunMinutes, 10);
            assert.equal((await (await h.request("/api/activities/" + record.id)).json()).settings.maxRunMinutes, 10);
        },
        { ...apiActivity, maxRunMinutes: 5 },
    );
});
