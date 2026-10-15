import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually } from "./fixtures/guiTestHelpers.js";

const pendingKey = "ticketpilot-ticketplus-purchase-request";
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
        await work(h, page, record, requests);
        assert(!requests.some(request => request.path === "/api/contact"), "TicketPlus 不得讀寫 Klook 聯絡設定");
    } finally {
        await browser.close();
        await h.dispose();
    }
}

async function edit(page: Page) {
    await page.locator("#selectTicketPlus").click();
    await page.getByRole("button", { name: "編輯活動", exact: true }).click();
    await page.getByRole("button", { name: "① 活動與順位", exact: true }).waitFor();
}

async function review(page: Page) {
    await page.getByRole("button", { name: "② 確認與開始", exact: true }).click();
    await page.getByRole("region", { name: "購票前確認" }).waitFor();
}

function starts(requests: RequestLog) {
    return requests.filter(request => request.path === "/api/purchase" && request.method === "POST");
}

async function verifyInformation(h: Harness, page: Page) {
    await h.until(run => run?.status === "information-ready");
    await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁"));
    const report = await h.counts();
    assert.deepEqual(report.counts, { session: 1, plus: 2, submit: 1, dismiss: 0, information: 0, other: 0, terms: 0 });
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

test("TicketPlus 啟動 GUI：保存摘要到真 API、人工交接及資料頁，連點只啟動一次", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, record, requests) => {
        await page.evaluate(key => sessionStorage.setItem(key, "klook-independent-marker"), klookPendingKey);
        await edit(page);
        await review(page);
        const summary = await page.getByRole("region", { name: "購票前確認" }).innerText();
        for (const value of ["2026孿生姐妹之夜之鬼迷心竅", "2026-10-30", "20:00", "預售票", "2", "填寫資料頁"])
            assert(summary.includes(value));
        await page.getByRole("button", { name: "開始購票", exact: true }).evaluate(button => {
            (button as HTMLButtonElement).click();
            (button as HTMLButtonElement).click();
        });
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
        await verifyInformation(h, page);
        assert.equal(starts(requests).length, 1);
        assert.deepEqual(Object.keys(starts(requests)[0]!.body).sort(), [
            "activityId",
            "expectedActivity",
            "requestId",
        ]);
        assert.equal(starts(requests)[0]!.body.activityId, record.id);
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, apiActivity);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
        assert.equal(
            await page.evaluate(key => sessionStorage.getItem(key), klookPendingKey),
            "klook-independent-marker",
        );
    });
});

test("TicketPlus 啟動 GUI：未保存修改與新增草稿都不能啟動", async () => {
    await fixture(async (_h, page, _record, requests) => {
        await edit(page);
        await review(page);
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
        await page.getByLabel("票種名稱").fill("另一票種");
        await review(page);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#homeButton").click();
        await page.getByRole("button", { name: "新增活動", exact: true }).click();
        await page.getByRole("button", { name: "② 確認與開始", exact: true }).click();
        const start = page.getByRole("button", { name: "開始購票", exact: true });
        assert((await start.count()) === 0 || (await start.isDisabled()));
        assert.equal(starts(requests).length, 0);
    });
});

test("TicketPlus 啟動 GUI：跨場次及尚未接通排程可以讀取，但不能開始", async () => {
    for (const settings of [
        {
            ...apiActivity,
            targets: [...apiActivity.targets, { date: "2026-10-31", time: "20:00", ticketType: "B區", quantity: 1 }],
        },
        { ...apiActivity, saleSchedule: { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 } },
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
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () =>
            assert.match(await page.locator("#message").innerText(), /設定.*變更|設定.*不同|重新.*確認|設定.*不一致/),
        );
        assert.equal(starts(requests).length, 1);
        assert.equal(await h.snapshot(), null);
        await assert.rejects(readFile(h.report + ".starts", "utf8"), { code: "ENOENT" });
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
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
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        const ready = await h.until(run => Boolean(run?.loginConfirmation));
        await eventually(async () => assert(await page.evaluate(key => sessionStorage.getItem(key), pendingKey)));
        await page.reload();
        await page.locator("#selectTicketPlus").click();
        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
        await verifyInformation(h, page);
        assert.equal(starts(requests).length, 1);
        assert.equal(starts(requests)[0]!.body.requestId, ready.requestId);
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingKey), null);
    });
});

test("TicketPlus 啟動 GUI：開始回應晚於 SSE，導覽保留最新登入資格", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, _record, requests) => {
        // 只旁觀真實 SSE，確認本頁確實收過新資格後才釋放舊 POST 回應。
        await page.addInitScript(() => {
            const OriginalEventSource = window.EventSource;
            window.EventSource = class extends OriginalEventSource {
                constructor(url: string | URL, options?: EventSourceInit) {
                    super(url, options);
                    if (String(url).startsWith("/api/purchase/events")) {
                        this.addEventListener("message", event => {
                            const run = JSON.parse(event.data);
                            if (run?.loginConfirmation) {
                                (window as unknown as { observedLoginRun: string }).observedLoginRun = run.id;
                            }
                        });
                    }
                }
            };
        });
        await page.reload();
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
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            const ready = await h.until(run => Boolean(run?.loginConfirmation));
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
            await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
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
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
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
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await eventually(async () =>
                assert.match(await page.locator("#message").innerText(), /失敗|fetch|確認|連線/i),
            );
            await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
            assert(await page.getByLabel("票種名稱").isDisabled());
            await review(page);
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
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
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#message").innerText(), /不能更換活動或設定/));
        assert.equal(starts(requests).length, 0);
        assert.deepEqual(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), pendingKey), pending);
    });
});

test("TicketPlus 步驟 GUI：保存後前進，未保存修改禁止啟動，重新保存使用新張數", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, record, requests) => {
        await edit(page);
        assert.equal(await page.getByRole("region", { name: "購票前確認" }).count(), 0);
        await page.getByLabel("張數", { exact: true }).fill("1");
        await page.getByRole("button", { name: "儲存活動", exact: true }).click();
        await page.getByRole("region", { name: "購票前確認" }).waitFor();
        assert.equal(
            await page.getByRole("button", { name: "② 確認與開始", exact: true }).getAttribute("aria-current"),
            "step",
        );
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
        await page.getByLabel("張數", { exact: true }).fill("2");
        await review(page);
        assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
        assert.match(await page.getByRole("region", { name: "購票前確認" }).innerText(), /1 張/);
        assert.equal(starts(requests).length, 0);
        await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
        assert.equal(await page.getByLabel("張數", { exact: true }).inputValue(), "2");
        await page.getByRole("button", { name: "儲存活動", exact: true }).click();
        await page.getByRole("region", { name: "購票前確認" }).waitFor();
        const saved = await (await h.request("/api/activities/" + record.id)).json();
        assert.equal(saved.settings.targets[0].quantity, 2);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
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
                await h.request("/api/activities", apiActivity);
                await page.locator("#selectTicketPlus").click();
                await page.getByRole("button", { name: "編輯活動", exact: true }).first().click();
                await page.getByRole("button", { name: "③ 執行狀態", exact: true }).click();
                await page.getByText("尚未開始", { exact: true }).waitFor();
                await review(page);
                await page.getByRole("button", { name: "開始購票", exact: true }).click();
                await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).waitFor();
                const run = await h.snapshot();
                assert(run);
                assert.equal(
                    await page.getByRole("button", { name: "③ 執行狀態", exact: true }).getAttribute("aria-current"),
                    "step",
                );
                await page.getByRole("button", { name: "① 活動與順位", exact: true }).click();
                assert(await page.getByLabel("票種名稱").isDisabled());
                await page.getByRole("button", { name: "③ 執行狀態", exact: true }).click();
                await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
                await eventually(async () => assert.equal((await h.counts()).counts.submit, 1));
                await page.getByRole("button", { name: "停止購票", exact: true }).click();
                await page.getByRole("button", { name: "② 確認與開始", exact: true }).click();
                assert(await page.getByRole("button", { name: "開始購票", exact: true }).isDisabled());
                await page.getByRole("button", { name: "③ 執行狀態", exact: true }).click();
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
                    1,
                );
                assert.equal((await h.counts()).counts.submit, 1);
                assert.equal((await h.counts()).counts.information, 0);
                page.once("dialog", dialog => void dialog.accept());
                await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
                await h.until(current => !current?.occupied);
                await page.locator("#homeButton").click();
                // 兩筆活動同名，明確選另一筆，不能依名稱帶入上一輪狀態。
                const loadedOther = page.waitForResponse(response =>
                    /\/api\/activities\/[^/]+$/.test(new URL(response.url()).pathname),
                );
                await page
                    .locator("#activities tr")
                    .getByRole("button", { name: "編輯活動", exact: true })
                    .nth(1)
                    .click();
                assert.notEqual((await (await loadedOther).json()).id, starts(requests)[0]!.body.activityId);
                await page.getByRole("button", { name: "③ 執行狀態", exact: true }).click();
                await page.getByText("尚未開始", { exact: true }).waitFor();
                assert.equal(await page.locator("#status").count(), 0);
                assert.equal(starts(requests).length, 1);
            },
            apiActivity,
            "queue",
        );
    },
);

test("TicketPlus 開賣核心 GUI：已保存僅等待設定可啟動，呈現等待且可手動停止", { timeout: 25_000 }, async () => {
    const saleAt = new Date(Date.now() + 8 * 3600_000 + 60_000).toISOString().slice(0, 19) + "+08:00";
    const scheduled = { ...apiActivity, saleSchedule: { saleAt }, maxRunMinutes: 10 };
    await fixture(async (h, page, _record, requests) => {
        await edit(page);
        await review(page);
        const summary = await page.getByRole("region", { name: "購票前確認" }).innerText();
        assert.match(summary, /僅等待，不刷新/);
        assert.doesNotMatch(summary, /undefined|人工登入確認後開始計時/);
        assert.match(summary, /開始選場次前/);
        await page.getByRole("button", { name: "開始購票", exact: true }).click();
        await page.getByRole("button", { name: "我已登入，開始選票", exact: true }).click();
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /等待開賣/));
        assert.deepEqual(starts(requests)[0]!.body.expectedActivity, scheduled);
        assert.equal((await h.counts()).counts.session, 0);
        await page.getByRole("button", { name: "停止購票", exact: true }).click();
        await h.until(run => run?.status === "failed");
        await eventually(async () => assert.match(await page.locator("#status").innerText(), /購票已停止/));
        assert.equal((await h.counts()).counts.submit, 0);
    }, scheduled);
});
