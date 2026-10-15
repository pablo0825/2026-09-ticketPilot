import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
const stopLabel = "停止購票";
const loginLabel = "我已登入，開始選票";

async function fixture(mode: string, work: (h: Harness, page: Page, requests: string[]) => Promise<void>) {
    const h = await apiHarness(mode);
    const browser = await chromium.launch();
    const requests: string[] = [];
    try {
        const page = await browser.newPage();
        page.on("request", request => {
            if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
        });
        await work(h, page, requests);
        assert(!requests.includes("/api/purchase"), "停止操作不能另開購票流程");
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
    return h.until(run =>
        Boolean(run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login")),
    );
}

async function showRun(page: Page, url: string) {
    await page.goto(url);
    await page.getByRole("button", { name: "查看狀態", exact: true }).click();
    await page.locator("#status").waitFor();
}

async function unavailable(page: Page, label: string) {
    const button = page.getByRole("button", { name: label, exact: true });
    assert((await button.count()) === 0 || (await button.isDisabled()));
}

test("TicketPlus 停止 GUI：同輪連點只送一次停止，關窗前保留占用", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        await unavailable(page, loginLabel);
        await page.getByRole("button", { name: stopLabel, exact: true }).evaluate(element => {
            (element as HTMLButtonElement).click();
            (element as HTMLButtonElement).click();
        });
        const finished = await h.until(run => run?.status === "failed");
        assert.equal(finished.occupied, true);
        assert.equal(finished.browserOpen, true);
        assert.equal(finished.canCloseBrowser, true);
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "購票已停止"));
        await unavailable(page, loginLabel);
        await unavailable(page, stopLabel);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 0);
        assert.deepEqual((await h.counts()).counts, {
            session: 0,
            plus: 0,
            submit: 0,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        page.once("dialog", dialog => void dialog.accept());
        await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
        await h.until(run => !run?.occupied);
    });
});

test("TicketPlus 停止 GUI：頁面登入後仍可停止，加第一張後解除延遲不再加票或提交", { timeout: 30_000 }, async () => {
    await fixture("held-plus", async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        await h.login();
        await eventually(async () => assert.equal((await h.counts()).counts.plus, 1));
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(run => run?.status === "failed");
        await writeFile(h.report + ".control", "release-plus");
        await eventually(async () => assert.equal(await readFile(h.report + ".released", "utf8"), "yes"));
        assert.deepEqual((await h.counts()).counts, {
            session: 1,
            plus: 1,
            submit: 0,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 0);
    });
});

test("TicketPlus 停止 GUI：排隊停止保留提交一次並回報結果不明", { timeout: 30_000 }, async () => {
    await fixture("queue", async (h, page, requests) => {
        const run = await start(h);
        await showRun(page, h.url);
        await h.login();
        await eventually(async () => assert.equal((await h.counts()).counts.submit, 1));
        const stopRequest = page.waitForRequest(
            request => new URL(request.url()).pathname === "/api/purchase/stop" && request.method() === "POST",
        );
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        assert.deepEqual((await stopRequest).postDataJSON(), { runId: run.id });
        await h.until(run => run?.status === "unknown");
        await eventually(async () => {
            assert.equal(await page.locator("#status").innerText(), "購票已停止");
            assert.match(await page.locator("#status").locator("..").innerText(), /提交結果尚未確認/);
        });
        assert.equal((await h.counts()).counts.submit, 1);
        assert.equal((await h.counts()).counts.information, 0);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        await unavailable(page, stopLabel);
    });
});

test("TicketPlus 停止 GUI：後端接受但回應遺失，重載只恢復狀態不再送停止", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page, requests) => {
        await start(h);
        await page.route("**/api/purchase/stop", async route => {
            const response = await fetch(route.request().url(), {
                method: "POST",
                headers: await route.request().allHeaders(),
                body: route.request().postData(),
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 200);
            await response.text();
            await route.abort("failed");
        });
        await showRun(page, h.url);
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(run => run?.status === "failed");
        await showRun(page, h.url);
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        assert.equal(await page.locator("#status").innerText(), "購票已停止");
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal((await h.counts()).counts.submit, 0);
    });
});

function waitingRun(): PurchaseSnapshot {
    return {
        id: "fixture-stop",
        requestId: "fixture-stop",
        platform: "ticketplus",
        activityName: "停止測試",
        status: "running",
        browserOpen: true,
        occupied: true,
        canStop: true,
        message: "",
        loginConfirmation: { confirmationId: "fixture-login" },
        events: [
            {
                sequence: 1,
                at: "2026-10-15T00:00:00Z",
                event: { type: "ticketplus", stage: "waiting-for-login" },
            },
        ],
        historyTruncated: false,
    };
}

test("TicketPlus 停止 GUI：傳送未確認仍有舊資格時不重送或登入，新一輪不沿用舊鎖", async () => {
    await fixture("success", async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        await page.route("**/api/purchase/stop", route => route.abort("failed"));
        await showRun(page, h.url);
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "停止要求尚未確認"));
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        await page.locator("#brandHome").click();
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        current = { ...waitingRun(), id: "next-stop", requestId: "next-stop" };
        const receivedNext = page.waitForResponse(
            async response =>
                response.url().includes("/api/purchase/events?") && (await response.text()).includes("next-stop"),
        );
        feed.publish(current);
        await receivedNext;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator("#brandHome").click();
        await eventually(async () =>
            assert.equal(await page.getByRole("button", { name: "查看狀態", exact: true }).count(), 1),
        );
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => {
            const button = page.getByRole("button", { name: stopLabel, exact: true });
            assert.equal(await button.count(), 1);
            assert(await button.isEnabled());
        });
        assert.equal(requests.length, 1);
    });
});

test("TicketPlus 停止 GUI：Klook、歷史紀錄及缺停止資格均無停止操作", async () => {
    await fixture("success", async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        for (const next of [
            { ...waitingRun(), platform: "klook" as const },
            { ...waitingRun(), status: "failed" as const, occupied: false },
            { ...waitingRun(), canStop: undefined },
        ]) {
            current = next;
            feed.publish(current);
            await showRun(page, h.url);
            await unavailable(page, stopLabel);
        }
        assert.equal(requests.length, 0);
    });
});

test("TicketPlus 停止 GUI：停止回應仍是 running 時，晚到不能覆蓋已到資料頁終局", async () => {
    await fixture("success", async (h, page) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let received = false;
        let completed = false;
        await page.route("**/api/purchase/stop", async route => {
            const stale = { ...waitingRun(), stopRequest: { status: "sent" as const }, canStop: false };
            assert.equal(stale.status, "running");
            received = true;
            await gate;
            await route.fulfill({ json: { status: "sent", run: stale } });
            completed = true;
        });
        try {
            await showRun(page, h.url);
            await page.getByRole("button", { name: stopLabel, exact: true }).click();
            await eventually(async () => {
                await page.locator("#status").textContent();
                assert(received);
            });
            current = { ...waitingRun(), status: "information-ready", canStop: false, stopRequest: { status: "sent" } };
            feed.publish(current);
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁"));
            // 停止重播終局，避免後續快照掩蓋舊回應造成的倒退。
            feed.publish(undefined);
            release();
            await eventually(async () => {
                await page.locator("#status").textContent();
                assert(completed);
            });
            await page.evaluate(
                () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.equal(await page.locator("#status").innerText(), "已到填寫資料頁");
            await unavailable(page, stopLabel);
            await unavailable(page, loginLabel);
        } finally {
            release();
        }
    });
});
