import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("長紀錄在窄螢幕可捲動，閱讀舊紀錄時不被新事件拉回底部", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-status-scroll-"));
    const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
        runDirectory: join(directory, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const run = {
            id: "scroll-fixture",
            platform: "ticketplus",
            flowType: "purchase",
            activityName: "長紀錄測試",
            status: "running",
            occupied: true,
            browserOpen: true,
            canCloseBrowser: false,
            historyTruncated: false,
            events: Array.from({ length: 60 }, (_, index) => ({
                at: new Date().toISOString(),
                event: { type: "log", message: `紀錄 ${index} ${"長文字".repeat(30)}` },
            })),
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", run);
        await page.goto(service.url);
        await page.locator("#viewRun").click();
        await page.locator("details > summary").click();
        const logs = page.getByLabel("執行紀錄", { exact: true });
        assert(await logs.evaluate(el => el.scrollHeight > el.clientHeight));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const append = (message: string) => {
            run.events.push({ at: new Date().toISOString(), event: { type: "log", message } });
            feed.publish(run);
        };
        append("跟隨新事件");
        await eventually(async () => {
            assert.match(await logs.innerText(), /跟隨新事件/);
            assert(await logs.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2));
        });
        await logs.evaluate(el => {
            el.scrollTop = 0;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        append("保留閱讀位置");
        await eventually(async () => assert.match(await logs.innerText(), /保留閱讀位置/));
        assert.equal(await logs.evaluate(el => el.scrollTop), 0);
        assert(await page.locator("#closeBrowser").isHidden());
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
