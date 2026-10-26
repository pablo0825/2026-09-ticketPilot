import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import type { PurchaseSnapshot } from "../../../src/shared/runSnapshot.js";
import { apiActivity, apiHarness } from "../../fixtures/ticketplus/apiHarness.js";
import { enterTicketPlus, eventually, snapshotFeed } from "../../fixtures/guiTestHelpers.js";

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
    return h.until(run =>
        Boolean(run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login")),
    );
}

async function showRun(page: Page, url: string) {
    await page.goto(url);
    await enterTicketPlus(page);
    await page.getByRole("button", { name: /^查看(?:目前)?狀態$/ }).click();
    await page.locator("#status").waitFor();
}

async function verifyInformation(h: Harness, page: Page) {
    await h.until(run => run?.status === "payment-ready");
    await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到付款頁"));
    assert.deepEqual((await h.counts()).counts, {
        session: 1,
        plus: 2,
        submit: 1,
        dismiss: 0,
        information: 1,
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

test("TicketPlus 登入 GUI：等待網頁登入，重載不導航，登入後自動更新資料頁狀態", { timeout: 30_000 }, async () => {
    await fixture(async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        assert.equal(await page.getByRole("button", { name: confirmLabel, exact: true }).count(), 0);
        await showRun(page, h.url);
        assert.deepEqual((await h.counts()).requests, ["/"]);
        assert.equal((await h.counts()).counts.session, 0);
        await h.login();
        await verifyInformation(h, page);
        await showRun(page, h.url);
        await verifyInformation(h, page);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 0);
        assert.equal((await h.counts()).requests.filter((path: string) => path.startsWith("/activity/")).length, 1);
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

test("TicketPlus 登入 GUI：未知平台、歷史紀錄及無即時資格都不能確認", async () => {
    await fixture(async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        for (const next of [
            waitingRun(),
            { ...waitingRun(), platform: null },
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
