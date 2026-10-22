import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { saveContactDetails } from "../src/config/contact.config.js";
import { startLocalServer } from "../src/local/server.js";
import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

const oldRun = {
    id: "old",
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
    await store.save({
        eventName: "新活動",
        platform: "klook",
        eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
        fallbackMode: "STRICT",
        excludeKeywords: [],
        targets: [{ date: "2026-11-02", time: "19:30", area: "A區", quantity: 1, adjacent: false }],
    });
    await saveContactDetails(
        {
            firstName: "Demo",
            lastName: "Test",
            regionLabel: "台灣 (+886)",
            phone: "0912345678",
            email: "fixture@example.com",
        },
        join(directory, "contact.json"),
    );
    const service = await startLocalServer(store, {
        contactPath: join(directory, "contact.json"),
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
                activityName: "新活動",
                status: "running",
                occupied: true,
                browserOpen: true,
            };
            await page.route("**/api/purchase", async route => {
                if (route.request().method() === "GET") return route.fulfill({ json: oldRun });
                if (streamFirst) {
                    feed.publish({ ...next, status: "payment-ready", canCloseBrowser: true });
                    await eventually(async () =>
                        assert.match((await page.locator("#homeRun").textContent()) ?? "", /自動流程已完成/),
                    );
                }
                await route.fulfill({ json: next });
            });
            await page.goto(service.url);
            await page.locator("#selectKlook").click();
            await page.getByText("編輯活動", { exact: true }).click();
            await page.getByRole("button", { name: "③ 確認與開始" }).click();
            await page.locator("#confirm").check();
            await page.locator("#start").click();
            await page.locator("#step4").waitFor();
            assert.equal(await page.locator("#status").innerText(), streamFirst ? "已到付款頁" : "正在購票");
            await page.locator("#homeButton").click();
            assert(await page.locator("#new").isDisabled());
            assert(await page.getByText("編輯活動", { exact: true }).isDisabled());
            assert(await page.getByText("刪除", { exact: true }).isDisabled());
            assert(await page.locator("#viewRun").isVisible());
            await page.close();
        }
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
