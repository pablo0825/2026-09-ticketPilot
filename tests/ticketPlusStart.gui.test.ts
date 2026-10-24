import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { enterTicketPlus, eventually } from "./fixtures/guiTestHelpers.js";

const pendingKey = "ticketpilot-ticketplus-purchase-request";
const sharedPendingKey = "ticketpilot-platform-purchase-request";
const klookPendingKey = "ticketpilot-purchase-request";
type Harness = Awaited<ReturnType<typeof apiHarness>>;
type RequestLog = { path: string; method: string; body: any }[];

async function fixture(
    work: (h: Harness, page: Page, record: any, requests: RequestLog) => Promise<void>,
    settings: unknown = apiActivity,
    mode = "success",
) {
    const h = await apiHarness(mode);
    const browser = await chromium.launch();
    try {
        const record = await (await h.request("/api/activities", settings)).json();
        assert(record.id);
        const page = await browser.newPage();
        const requests: RequestLog = [];
        page.on("request", request => {
            requests.push({
                path: new URL(request.url()).pathname,
                method: request.method(),
                body: request.postDataJSON(),
            });
        });
        await page.goto(h.url);
        await enterTicketPlus(page);
        await work(h, page, record, requests);
        assert(!requests.some(request => request.path === "/api/contact"), "TicketPlus 不得讀寫 Klook 聯絡設定");
    } finally {
        await browser.close();
        await h.dispose();
    }
}

async function edit(page: Page) {
    await page.getByRole("button", { name: "編輯活動", exact: true }).click();
    await page.getByRole("button", { name: "活動與順位", exact: true }).waitFor();
}

async function review(page: Page) {
    await page.getByRole("button", { name: "確認與開始", exact: true }).click();
    await page.getByRole("region", { name: "活動摘要" }).waitFor();
}

async function confirmStart(page: Page) {
    const checkbox = page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ });
    if (await checkbox.isEnabled()) await checkbox.check();
}

function starts(requests: RequestLog) {
    return requests.filter(request => request.path === "/api/purchase" && request.method === "POST");
}

async function verifyInformation(h: Harness, page: Page) {
    await h.until(run => run?.status === "payment-ready");
    await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到付款頁"));
    const report = await h.counts();
    assert.deepEqual(report.counts, { session: 1, plus: 2, submit: 1, dismiss: 0, information: 1, other: 0, terms: 0 });
    assert.deepEqual(report.submissions, [
        [
            { name: "學生票", quantity: 0 },
            { name: "預售票", quantity: 2 },
            { name: "身障票", quantity: 0 },
        ],
    ]);
    assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
    assert.equal((await h.snapshot())!.occupied, true);
}

test("TicketPlus 啟動 GUI：保存摘要到真 API、網頁登入及資料頁，連點只啟動一次", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, record, requests) => {
        await page.evaluate(key => sessionStorage.setItem(key, "klook-independent-marker"), klookPendingKey);
        await edit(page);
        await review(page);
        const summary = await page.getByRole("region", { name: "活動摘要" }).innerText();
        for (const value of ["2026孿生姐妹之夜之鬼迷心竅", "2026-10-30", "20:00", "預售票", "2", "付款頁"])
            assert(summary.includes(value));
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).evaluate(button => {
            (button as HTMLButtonElement).click();
            (button as HTMLButtonElement).click();
        });
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await verifyInformation(h, page);
        assert.equal(requests.filter(request => request.method === "PUT").length, 0, "執行設定未變更時不應重新保存");
        assert.equal(starts(requests).length, 1);
        assert.deepEqual(Object.keys(starts(requests)[0]!.body).sort(), [
            "activityId",
            "expectedActivity",
            "requestId",
        ]);
        assert.equal(starts(requests)[0]!.body.activityId, record.id);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, apiActivity);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sharedPendingKey), null);
        assert.equal(
            await page.evaluate(key => sessionStorage.getItem(key), klookPendingKey),
            "klook-independent-marker",
        );
    });
});

test("TicketPlus 摘要：逐列呈現順位對應與活動連結，手機版表格可捲動", async () => {
    await fixture(
        async (_h, page, _record, requests) => {
            await edit(page);
            await review(page);
            const table = page.getByRole("region", { name: "購票順位", exact: true });
            const rows = table.locator("tbody tr");
            assert.deepEqual(await rows.nth(0).getByRole("cell").allTextContents(), [
                "1",
                "2026-10-30",
                "20:00",
                "預售票",
                "2",
            ]);
            assert.deepEqual(await rows.nth(1).getByRole("cell").allTextContents(), [
                "2",
                "2026-10-31",
                "18:30",
                "學生票",
                "1",
            ]);
            const link = page.getByRole("link", { name: apiActivity.eventUrl, exact: true });
            assert.equal(await link.getAttribute("href"), apiActivity.eventUrl);
            assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await table.evaluate(element => getComputedStyle(element).overflowX), "auto");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
            assert.equal(starts(requests).length, 0);
        },
        {
            ...apiActivity,
            targets: [...apiActivity.targets, { date: "2026-10-31", time: "18:30", ticketType: "學生票", quantity: 1 }],
        },
    );
});

test("TicketPlus 啟動 GUI：未保存修改與新增草稿都不能啟動", async () => {
    await fixture(async (_h, page, _record, requests) => {
        await edit(page);
        await review(page);
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        await page.getByLabel("票種名稱").fill("另一票種");
        await review(page);
        await confirmStart(page);
        const summary = await page.getByRole("region", { name: "活動摘要" }).innerText();
        assert.match(summary, /活動與順位有.*修改/);
        assert.doesNotMatch(summary, /另一票種/);
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#homeButton").click();
        await page.getByRole("button", { name: "新增活動", exact: true }).click();
        await page.getByLabel("活動名稱", { exact: true }).fill("尚未儲存的新活動");
        // 未儲存的新活動，麵包屑不跟著輸入的名稱變。
        assert.equal(await page.locator(".breadcrumb-current").innerText(), "新增活動");
        await page.getByRole("button", { name: "確認與開始", exact: true }).click();
        assert.equal(await page.getByText("請先儲存活動設定。", { exact: true }).count(), 1);
        const start = page.getByRole("button", { name: "開始購票", exact: true });
        assert((await start.count()) === 0 || (await start.isDisabled()));
        assert.equal(starts(requests).length, 0);
    });
});

test("TicketPlus 啟動 GUI：跨場次設定可以讀取，但不能開始", async () => {
    for (const settings of [
        {
            ...apiActivity,
            targets: [...apiActivity.targets, { date: "2026-10-31", time: "20:00", ticketType: "B區", quantity: 1 }],
        },
    ]) {
        await fixture(async (_h, page, _record, requests) => {
            await edit(page);
            await review(page);
            assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
            assert.equal(starts(requests).length, 0);
        }, settings);
    }
});

test("TicketPlus 啟動 GUI：別頁修改保存設定後，真後端拒絕舊摘要而不開 worker", async () => {
    await fixture(async (h, page, record, requests) => {
        await edit(page);
        await review(page);
        const response = await fetch(h.url + "/api/activities/" + record.id, {
            method: "PUT",
            headers: { ...h.headers, "X-Activity-Revision": record.updatedAt },
            body: JSON.stringify({ ...apiActivity, targets: [{ ...apiActivity.targets[0], quantity: 3 }] }),
        });
        assert.equal(response.status, 200);
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () =>
            assert.match(await page.locator("#message").innerText(), /設定.*變更|設定.*不同|重新.*確認|設定.*不一致/),
        );
        assert.equal(starts(requests).length, 1);
        assert.equal(await h.snapshot(), null);
        await assert.rejects(readFile(h.report + ".starts", "utf8"), { code: "ENOENT" });
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sharedPendingKey), null);
    });
});

test("TicketPlus 啟動 GUI：真接受後回應遺失，重載查詢原請求而不重開", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, _record, requests) => {
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            const response = await route.fetch({ timeout: 5000 });
            assert.equal(response.status(), 200);
            await route.abort("failed");
        });
        await edit(page);
        await review(page);
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        const ready = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await eventually(async () => assert(await page.evaluate(key => sessionStorage.getItem(key), sharedPendingKey)));
        await page.reload();

        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await verifyInformation(h, page);
        assert.equal(starts(requests).length, 1);
        assert.equal(starts(requests)[0]!.body.requestId, ready.requestId);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), sharedPendingKey), null);
    });
});

test("TicketPlus 啟動 GUI：開始回應晚於 SSE，導覽保留最新等待登入狀態", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, _record, requests) => {
        // 只旁觀真實 SSE，確認本頁確實收過等待登入狀態後才釋放舊 POST 回應。
        await page.addInitScript(() => {
            const OriginalEventSource = window.EventSource;
            window.EventSource = class extends OriginalEventSource {
                constructor(url: string | URL, options?: EventSourceInit) {
                    super(url, options);
                    if (String(url).startsWith("/api/purchase/events")) {
                        this.addEventListener("message", event => {
                            const run = JSON.parse(event.data);
                            if (
                                run?.events.some(
                                    (item: any) =>
                                        item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                                )
                            ) {
                                (window as unknown as { observedLoginRun: string }).observedLoginRun = run.id;
                            }
                        });
                    }
                }
            };
        });
        await page.reload();
        await enterTicketPlus(page);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            const response = await route.fetch({ timeout: 5000 });
            await gate;
            await route.fulfill({ response });
        });
        try {
            await edit(page);
            await review(page);
            await confirmStart(page);
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            const ready = await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            await eventually(async () =>
                assert.equal(
                    await page.evaluate(() => (window as unknown as { observedLoginRun?: string }).observedLoginRun),
                    ready.id,
                ),
            );
            await page.evaluate(
                () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            release();
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            await h.login();
            await verifyInformation(h, page);
            assert.equal(starts(requests).length, 1);
        } finally {
            release();
        }
    });
});

test("TicketPlus 啟動 GUI：查不到原請求仍保留 pending，不能把未知當未啟動", async () => {
    await fixture(async (_h, page, record, requests) => {
        const pending = {
            version: 1,
            requestId: "uncertain-request",
            activityId: record.id,
            signature: JSON.stringify(record.settings),
        };
        await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
            key: pendingKey,
            value: pending,
        });
        await edit(page);
        await review(page);
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        assert(await page.getByLabel("票種名稱").isDisabled());
        await review(page);
        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /無法核對.*保留/));
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), pendingKey), pending);
        assert.equal(starts(requests).length, 0);
    });
});

test(
    "TicketPlus 啟動 GUI：未收到接受結果時，同設定重試沿用原 ID 且只啟動一個 worker",
    { timeout: 30_000 },
    async () => {
        await fixture(async (h, page, _record, requests) => {
            let intercepted = 0;
            await page.route("**/api/purchase", async route => {
                if (route.request().method() !== "POST") return route.continue();
                intercepted++;
                if (intercepted === 1) return route.abort("failed");
                return route.continue();
            });
            await edit(page);
            await review(page);
            await confirmStart(page);
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await eventually(async () =>
                assert.match(await page.locator("#message").innerText(), /失敗|fetch|確認|連線/i),
            );
            await page.getByRole("button", { name: "活動與順位", exact: true }).click();
            assert(await page.getByLabel("票種名稱").isDisabled());
            await review(page);
            await confirmStart(page);
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            await h.login();
            await verifyInformation(h, page);
            assert.equal(starts(requests).length, 2);
            assert.equal(starts(requests)[0]!.body.requestId, starts(requests)[1]!.body.requestId);
            assert.deepEqual(starts(requests)[0]!.body.expectedActivity, starts(requests)[1]!.body.expectedActivity);
        });
    },
);

test("TicketPlus 啟動 GUI：另一活動的 pending 不允許改用新設定啟動", async () => {
    await fixture(async (_h, page, record, requests) => {
        const pending = {
            version: 1,
            requestId: "old-request",
            activityId: "another-activity",
            signature: JSON.stringify(record.settings),
        };
        await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
            key: pendingKey,
            value: pending,
        });
        await edit(page);
        await review(page);
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /不能更換活動或設定/));
        assert.equal(starts(requests).length, 0);
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), pendingKey), pending);
    });
});

test("TicketPlus 啟動 GUI：同活動但不同設定的 pending 不能換成新請求", async () => {
    await fixture(async (_h, page, record, requests) => {
        const pending = {
            version: 1,
            requestId: "same-activity-old-settings",
            activityId: record.id,
            signature: JSON.stringify({
                ...record.settings,
                targets: [{ ...record.settings.targets[0], quantity: 1 }],
            }),
        };
        await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
            key: pendingKey,
            value: pending,
        });
        await edit(page);
        await review(page);
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /不能更換活動或設定/));
        assert.equal(starts(requests).length, 0);
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), pendingKey), pending);
    });
});

test("TicketPlus 步驟 GUI：保存後前進，未保存修改禁止啟動，重新保存使用新張數", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, record, requests) => {
        await edit(page);
        assert.equal(await page.getByRole("region", { name: "活動摘要" }).count(), 0);
        await page.getByLabel("張數", { exact: true }).fill("1");
        await page.getByRole("button", { name: "下一步", exact: true }).click();
        await page.getByRole("region", { name: "活動摘要" }).waitFor();
        assert.equal(
            await page.getByRole("button", { name: "確認與開始", exact: true }).getAttribute("aria-current"),
            "step",
        );
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        await page.getByLabel("張數", { exact: true }).fill("2");
        await review(page);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        assert.deepEqual(
            await page
                .getByRole("region", { name: "購票順位", exact: true })
                .locator("tbody tr")
                .first()
                .getByRole("cell")
                .allTextContents(),
            ["1", "2026-10-30", "20:00", "預售票", "1"],
        );
        assert.equal(starts(requests).length, 0);
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        assert.equal(await page.getByLabel("張數", { exact: true }).inputValue(), "2");
        await page.getByRole("button", { name: "下一步", exact: true }).click();
        await page.getByRole("region", { name: "活動摘要" }).waitFor();
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 2);
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await verifyInformation(h, page);
        assert.equal(starts(requests).length, 1);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, saved.settings);
    });
});

test(
    "TicketPlus 步驟 GUI：第三步保留登入、停止與關窗，切換不重啟，另一同名活動無舊結果",
    { timeout: 30_000 },
    async () => {
        await fixture(
            async (h, page, record, requests) => {
                const other = await (await h.request("/api/activities", apiActivity)).json();
                await page.locator("#brandHome").click();
                await enterTicketPlus(page);
                await page
                    .locator(`[data-activity-id="${record.id}"]`)
                    .getByRole("button", { name: "編輯活動", exact: true })
                    .click();
                await page.getByRole("button", { name: "執行狀態", exact: true }).click();
                await page.getByText("尚未開始", { exact: true }).waitFor();
                await review(page);
                await confirmStart(page);
                await page.getByRole("button", { name: "開始購票", exact: true }).click();
                await h.until(run =>
                    Boolean(
                        run?.events.some(
                            item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                        ),
                    ),
                );
                const run = await h.snapshot();
                assert(run);
                assert.equal(
                    await page.getByRole("button", { name: "執行狀態", exact: true }).getAttribute("aria-current"),
                    "step",
                );
                await page.getByRole("button", { name: "活動與順位", exact: true }).click();
                assert(await page.getByLabel("票種名稱").isDisabled());

                // 執行中麵包屑顯示鎖定標籤；完整原因平時隱藏，滑鼠移上去或鍵盤聚焦時才顯示。
                const lock = page.locator(".breadcrumb .lock-chip");
                const tip = lock.locator(".lock-chip-tip");
                assert.match(await lock.innerText(), /^🔒 設定已鎖定/);
                assert.match((await lock.textContent()) ?? "", /設定已鎖定：購票瀏覽器使用中/);
                assert(((await tip.boundingBox())?.width ?? 0) <= 1);
                await lock.hover();
                assert(((await tip.boundingBox())?.width ?? 0) > 100);
                await page.mouse.move(0, 0);
                assert(((await tip.boundingBox())?.width ?? 0) <= 1);
                await page.locator("#homeButton").focus();
                await page.keyboard.press("Tab");
                assert.equal(await lock.evaluate(element => element === document.activeElement), true);
                assert(((await tip.boundingBox())?.width ?? 0) > 100);
                assert.doesNotMatch(await page.locator(".breadcrumb-current").innerText(), /設定已鎖定/);
                await page.getByRole("button", { name: "執行狀態", exact: true }).click();
                await h.until(run =>
                    Boolean(
                        run?.events.some(
                            item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                        ),
                    ),
                );
                await h.login();
                await eventually(async () => assert.equal((await h.counts()).counts.submit, 1));
                page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
                await page.getByRole("button", { name: "停止購票", exact: true }).click();
                await page.getByRole("button", { name: "確認與開始", exact: true }).click();
                assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
                await page.getByRole("button", { name: "執行狀態", exact: true }).click();
                await eventually(async () => assert.equal(await page.locator("#status").innerText(), "購票已停止"));
                assert.equal((await h.snapshot())!.id, run.id);
                assert.equal(starts(requests).length, 1);
                assert.equal(
                    requests.filter(request => request.path === "/api/purchase/stop" && request.method === "POST")
                        .length,
                    1,
                );
                assert.equal(
                    requests.filter(
                        request => request.path === "/api/purchase/confirm-login" && request.method === "POST",
                    ).length,
                    0,
                );
                assert.equal((await h.counts()).counts.submit, 1);
                assert.equal((await h.counts()).counts.information, 0);
                page.once("dialog", dialog => void dialog.accept());
                await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
                await h.until(current => !current?.occupied);
                await eventually(async () => assert.equal(await page.locator(".lock-chip").count(), 0));
                await page.locator("#homeButton").click();
                // 兩筆活動同名，明確選另一筆，不能依名稱帶入上一輪狀態。
                const loadedOther = page.waitForResponse(response =>
                    /\/api\/activities\/[^/]+$/.test(new URL(response.url()).pathname),
                );
                await page
                    .locator(`[data-activity-id="${other.id}"]`)
                    .getByRole("button", { name: "編輯活動", exact: true })
                    .click();
                assert.notEqual((await (await loadedOther).json()).id, starts(requests)[0]!.body.activityId);
                await page.getByRole("button", { name: "執行狀態", exact: true }).click();
                await page.getByText("尚未開始", { exact: true }).waitFor();
                assert.equal(await page.locator("#status").count(), 0);
                assert.equal(starts(requests).length, 1);
            },
            apiActivity,
            "queue",
        );
    },
);

test("TicketPlus 開賣核心 GUI：未填提前秒數採 1 秒，可啟動且等待中可停止", { timeout: 25_000 }, async () => {
    const saleAt = new Date(Date.now() + 8 * 3600_000 + 60_000).toISOString().slice(0, 19) + "+08:00";
    const scheduled = { ...apiActivity, saleSchedule: { saleAt }, maxRunMinutes: 10 };
    await fixture(async (h, page, _record, requests) => {
        await edit(page);
        await review(page);
        const summary = await page.getByRole("region", { name: "活動摘要" }).innerText();
        assert.equal(await page.getByRole("combobox", { name: "提前刷新", exact: true }).inputValue(), "1");
        assert.doesNotMatch(summary, /undefined|人工登入確認後開始計時/);
        assert.equal(await page.getByLabel("最長執行時間（分鐘）").inputValue(), "10");
        await confirmStart(page);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, scheduled);
        assert.equal((await h.counts()).counts.session, 0);
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: "停止購票", exact: true }).click();
        await h.until(run => run?.status === "failed");
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /購票已停止/));
        assert.equal((await h.counts()).counts.submit, 0);
    }, scheduled);
});

for (const minutes of [undefined, 5]) {
    test(`TicketPlus 舊待確認期限 ${minutes ?? "缺值"}：只查原結果，不保存預設值或另啟 worker`, async () => {
        const { maxRunMinutes: _duration, ...base } = apiActivity;
        const legacy = minutes === undefined ? base : { ...base, maxRunMinutes: minutes };
        await fixture(async (h, page, record, requests) => {
            const pending = {
                version: 1,
                requestId: "legacy-duration-pending",
                activityId: record.id,
                signature: JSON.stringify(legacy),
            };
            await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
                key: pendingKey,
                value: pending,
            });
            await edit(page);
            await review(page);
            assert(await page.getByLabel("最長執行時間（分鐘）").isDisabled());
            const beforeGets = requests.filter(
                request => request.path === "/api/purchase" && request.method === "GET",
            ).length;
            await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
            await eventually(async () => assert.match(await page.locator("#message").innerText(), /無法核對.*保留/));
            assert(
                requests.filter(request => request.path === "/api/purchase" && request.method === "GET").length >
                    beforeGets,
            );
            assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), pendingKey), pending);
            assert.equal(requests.filter(request => request.method === "PUT").length, 0);
            assert.equal(starts(requests).length, 0);
            assert.equal(await h.snapshot(), null);
            assert.deepEqual((await (await h.request("/api/activities/" + record.id)).json()).settings, legacy);
            await assert.rejects(readFile(h.report + ".starts", "utf8"), { code: "ENOENT" });
        }, legacy);
    });
}

test("TicketPlus 舊缺值 pending：接受原結果後解除待確認，不補寫 10 或再送啟動", async () => {
    const { maxRunMinutes: _duration, ...legacy } = apiActivity;
    await fixture(async (h, page, record, requests) => {
        const pending = {
            version: 1,
            requestId: "accepted-legacy-request",
            activityId: record.id,
            signature: JSON.stringify(legacy),
        };
        await page.evaluate(({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)), {
            key: pendingKey,
            value: pending,
        });
        await edit(page);
        await review(page);
        // 模擬升級前已接受的舊流程狀態；驗證 GUI 查詢交接，不模擬新的啟動成功。
        const accepted = {
            id: "accepted-legacy-run",
            requestId: pending.requestId,
            platform: "ticketplus",
            activityId: record.id,
            activityName: legacy.eventName,
            status: "information-ready",
            browserOpen: false,
            occupied: false,
            message: "已到填寫資料頁",
            events: [],
            historyTruncated: false,
        };
        await page.route("**/api/purchase", route => {
            assert.equal(route.request().method(), "GET");
            return route.fulfill({ json: accepted });
        });
        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await eventually(async () =>
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null),
        );
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁"));
        assert.equal(requests.filter(request => request.method === "PUT").length, 0);
        assert.equal(starts(requests).length, 0);
        assert.deepEqual((await (await h.request("/api/activities/" + record.id)).json()).settings, legacy);
        await assert.rejects(readFile(h.report + ".starts", "utf8"), { code: "ENOENT" });
    }, legacy);
});
