import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/storage/activityStore.js";
import { startLocalServer } from "../src/server/server.js";
import type { PurchaseSnapshot } from "../src/shared/runSnapshot.js";
import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

for (const mode of ["accepted", "late", "wrong-platform"] as const) {
    test(`關窗回應核對身份與即時狀態：${mode}`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "close-ordering-"));
        const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
            runDirectory: join(directory, "runtime"),
        });
        const browser = await chromium.launch();
        let release = () => {};
        try {
            const page = await browser.newPage();
            const run: PurchaseSnapshot = {
                platform: "ticketplus",
                id: "run",
                requestId: "request",
                activityName: "fixture",
                status: "payment-ready",
                browserOpen: true,
                occupied: true,
                canCloseBrowser: true,
                message: "",
                events: [],
                historyTruncated: false,
            };
            const closed: PurchaseSnapshot = { ...run, browserOpen: false, occupied: false, canCloseBrowser: false };
            const feed = await snapshotFeed(page, "/api/purchase/events", run);
            await page.route("**/api/purchase", route => route.fulfill({ json: run }));
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            let requests = 0;
            await page.route("**/api/purchase/close-browser", async route => {
                requests++;
                await gate;
                await route.fulfill({ json: mode === "wrong-platform" ? { ...closed, platform: null } : closed });
            });
            await page.goto(service.url);
            await page.getByRole("button", { name: "查看目前狀態", exact: true }).click();
            await page.locator("#status").waitFor();
            feed.publish(undefined);
            page.once("dialog", dialog => dialog.accept());
            const response = page.waitForResponse("**/api/purchase/close-browser");
            await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
            await eventually(async () => assert.equal(requests, 1));
            if (mode === "late") {
                feed.publish({ ...closed, status: "unknown" });
                await eventually(async () => assert.equal(await page.locator("#status").innerText(), "購票已停止"));
                feed.publish(undefined);
            }
            release();
            await (await response).finished();
            await eventually(async () =>
                assert.doesNotMatch(await page.locator("#instruction").innerText(), /正在關閉/),
            );
            if (mode === "late") assert.equal(await page.locator("#status").innerText(), "購票已停止");
            if (mode === "accepted") assert.match(await page.locator("#instruction").innerText(), /瀏覽器已關閉/);
            if (mode === "wrong-platform") {
                assert.equal(await page.locator("#status").innerText(), "已到付款頁");
                assert.match(await page.locator("#instruction").innerText(), /手動完成付款/);
            }
            assert.equal(requests, 1);
        } finally {
            release();
            await browser.close();
            await service.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
