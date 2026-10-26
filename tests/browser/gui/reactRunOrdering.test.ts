import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { apiActivity } from "../../fixtures/ticketplus/apiHarness.js";
import { startLocalServer } from "../../../src/server/server.js";
import { enterTicketPlus, snapshotFeed, eventually } from "../../fixtures/guiTestHelpers.js";

const oldRun = {
    id: "old",
    platform: "ticketplus",
    requestId: "old",
    activityName: "舊輪次",
    status: "failed",
    occupied: false,
    browserOpen: false,
    events: [],
    historyTruncated: false,
    message: "舊結果",
};

test("React：新 POST 早於 SSE 時立即占用；SSE 先到時晚回應不倒退終態", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-react-order-"));
    const store = new ActivityStore(join(directory, "events"));
    const record = await store.save({ ...apiActivity, eventName: "新活動" });
    const service = await startLocalServer(store, {
        runDirectory: join(directory, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        for (const streamFirst of [false, true]) {
            const page = await browser.newPage();
            // 初始 GET 提供舊輪次；SSE 一開始不傳資料，避免重播舊輪次干擾順序。
            const feed = await snapshotFeed(page, "/api/purchase/events", undefined);
            const next = {
                ...oldRun,
                id: "new",
                activityId: record.id,
                activityName: "新活動",
                status: "running",
                occupied: true,
                browserOpen: true,
            };
            await page.route("**/api/purchase", async route => {
                if (route.request().method() === "GET") return route.fulfill({ json: oldRun });
                if (streamFirst) {
                    feed.publish({ ...next, status: "payment-ready", canCloseBrowser: true });
                    await eventually(async () => assert.equal(await page.locator(".breadcrumb .lock-chip").count(), 1));
                }
                await route.fulfill({ json: { ...next, requestId: route.request().postDataJSON().requestId } });
            });
            await page.goto(service.url);
            await enterTicketPlus(page);
            await page.getByText("編輯活動", { exact: true }).click();
            await page.getByRole("button", { name: "確認與開始" }).click();
            await page.getByRole("checkbox", { name: /我已確認活動、順位與張數/ }).check();
            await page.getByRole("button", { name: "開始購票", exact: true }).click();
            await page.locator("#status").waitFor();
            assert.equal(await page.locator("#status").innerText(), streamFirst ? "已到付款頁" : "正在購票");
            await page.locator("#homeButton").click();
            assert(await page.locator("#new").isDisabled());
            assert.equal(await page.getByText("編輯活動", { exact: true }).count(), 0);
            assert(await page.getByText("刪除", { exact: true }).isDisabled());
            assert(await page.getByRole("button", { name: "查看狀態", exact: true }).isVisible());
            await page.close();
        }
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
