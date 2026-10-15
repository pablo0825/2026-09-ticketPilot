import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
const confirmLabel = "我已登入，開始選票";

async function fixture(work: (h: Harness, page: Page, requests: string[]) => Promise<void>) {
    const h = await apiHarness();
    const browser = await chromium.launch();
    const requests: string[] = [];
    try {
        const page = await browser.newPage();
        page.on("request", request => {
            if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
        });
        await work(h, page, requests);
        assert(!requests.includes("/api/purchase"), "登入交接不應自行啟動新流程");
    } finally {
        await browser.close();
        await h.dispose();
    }
}

async function start(h: Harness) {
    const record = await (await h.request("/api/activities", apiActivity)).json();
    const response = await h.request("/api/purchase", {
        requestId: randomUUID(),
        activityId: record.id,
        expectedActivity: apiActivity,
    });
    assert.equal(response.status, 200);
    return h.until(run => Boolean(run?.loginConfirmation));
}

async function showRun(page: Page, url: string) {
    await page.goto(url);
    await page.getByRole("button", { name: "查看狀態", exact: true }).click();
    await page.locator("#status").waitFor();
}

async function verifyInformation(h: Harness, page: Page) {
    await h.until(run => run?.status === "information-ready");
    await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁"));
    assert.deepEqual((await h.counts()).counts, {
        session: 1,
        plus: 2,
        submit: 1,
        dismiss: 0,
        information: 0,
        other: 0,
        terms: 0,
    });
    assert.deepEqual((await h.counts()).submissions, [
        [
            { name: "學生票", quantity: 0 },
            { name: "預售票", quantity: 2 },
            { name: "身障票", quantity: 0 },
        ],
    ]);
    assert.equal((await h.snapshot())!.occupied, true);
    assert.equal(await page.getByRole("button", { name: confirmLabel, exact: true }).count(), 0);
}

test("TicketPlus 登入 GUI：真 API 交接只執行一次，晚回應不覆蓋資料頁狀態", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, requests) => {
        const run = await start(h);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let responseReceived = false;
        let responseFinished = false;
        await page.route("**/api/purchase/confirm-login", async route => {
            assert.deepEqual(route.request().postDataJSON(), {
                runId: run.id,
                confirmationId: run.loginConfirmation!.confirmationId,
            });
            const response = await fetch(route.request().url(), {
                method: "POST",
                headers: await route.request().allHeaders(),
                body: route.request().postData(),
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 200);
            const body = await response.text();
            responseReceived = true;
            await gate;
            await route.fulfill({ status: response.status, contentType: "application/json", body });
            responseFinished = true;
        });
        try {
            await showRun(page, h.url);
            // 同一個事件迴圈連點，驗證同步鎖，不能只依靠下一次 React render。
            await page.getByRole("button", { name: confirmLabel, exact: true }).evaluate(element => {
                (element as HTMLButtonElement).click();
                (element as HTMLButtonElement).click();
            });
            await eventually(async () => {
                assert(
                    responseReceived,
                    JSON.stringify({ requests, snapshot: await h.snapshot(), counts: await h.counts() }),
                );
            });
            await verifyInformation(h, page);
            release();
            await eventually(async () => {
                assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁");
                assert(responseFinished);
            });
            await page.evaluate(
                () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁");
            assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 1);
        } finally {
            release();
        }
    });
});

test("TicketPlus 登入 GUI：後端接受但回應遺失，依即時結果前進且重載不重送", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, requests) => {
        await start(h);
        await page.route("**/api/purchase/confirm-login", async route => {
            const response = await route.fetch({ timeout: 3000, postData: route.request().postData()! });
            assert.equal(response.status(), 200);
            await route.abort("failed");
        });
        await showRun(page, h.url);
        await page.getByRole("button", { name: confirmLabel, exact: true }).click();
        await verifyInformation(h, page);
        await showRun(page, h.url);
        await verifyInformation(h, page);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 1);
    });
});

test("TicketPlus 登入 GUI：尚未確認時重載只恢復即時資格，不自動交接", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        await page.getByRole("button", { name: confirmLabel, exact: true }).waitFor();
        await showRun(page, h.url);
        assert(await page.getByRole("button", { name: confirmLabel, exact: true }).isEnabled());
        assert.equal(requests.length, 0);
        assert.equal((await h.counts()).counts.session, 0);
        await page.getByRole("button", { name: confirmLabel, exact: true }).click();
        await verifyInformation(h, page);
    });
});

function waitingRun(): PurchaseSnapshot {
    return {
        id: "fixture-run",
        requestId: "fixture-run",
        platform: "ticketplus",
        activityName: "登入測試",
        status: "running",
        browserOpen: true,
        occupied: true,
        message: "",
        loginConfirmation: { confirmationId: "fixture-confirmation" },
        events: [
            {
                sequence: 1,
                at: "2026-10-15T00:00:00Z",
                event: { type: "ticketplus", stage: "login-ready", confirmationId: "fixture-confirmation" },
            },
        ],
        historyTruncated: false,
    };
}

test("TicketPlus 登入 GUI：Klook、歷史紀錄及無即時資格都不能確認", async () => {
    await fixture(async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        for (const next of [
            { ...waitingRun(), platform: "klook" as const },
            { ...waitingRun(), status: "failed" as const, occupied: false },
            { ...waitingRun(), loginConfirmation: undefined },
        ]) {
            current = next;
            feed.publish(current);
            await showRun(page, h.url);
            assert.equal(await page.getByRole("button", { name: confirmLabel, exact: true }).count(), 0);
        }
        assert.equal(requests.length, 0);
    });
});

test("TicketPlus 登入 GUI：送出結果不明且舊資格仍廣播時，本頁不再提供重送", async () => {
    await fixture(async (h, page, requests) => {
        const current = waitingRun();
        await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        await page.route("**/api/purchase/confirm-login", route => route.abort("failed"));
        await showRun(page, h.url);
        await page.getByRole("button", { name: confirmLabel, exact: true }).click();
        await eventually(async () => {
            const button = page.getByRole("button", { name: confirmLabel, exact: true });
            assert((await button.count()) === 0 || (await button.isDisabled()));
            assert.match(await page.getByRole("status").innerText(), /未確認|失敗|連線/);
        });
        // 改變頁面再回來，仍是同一個已消耗資格，不能恢復按鈕。
        await page.locator("#brandHome").click();
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        const button = page.getByRole("button", { name: confirmLabel, exact: true });
        assert((await button.count()) === 0 || (await button.isDisabled()));
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 1);
    });
});
