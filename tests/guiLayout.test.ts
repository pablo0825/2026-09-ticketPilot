import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Locator } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { enterTicketPlus, snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

async function assertJoined(top: Locator, bottom: Locator) {
    const topBox = await top.boundingBox();
    const bottomBox = await bottom.boundingBox();
    assert(topBox && bottomBox);
    assert(Math.abs(topBox.y + topBox.height - bottomBox.y) < 1, "標題／分頁與內容不可有空隙");
    assert(Math.abs(topBox.x - bottomBox.x) < 1);
    assert(Math.abs(topBox.width - bottomBox.width) < 1);
}

test("標題列與分頁連接內容外框，桌面與手機保留底線選中樣式", async () => {
    const h = await apiHarness();
    const browser = await chromium.launch();
    try {
        const record = await (await h.request("/api/activities", apiActivity)).json();
        assert(record.id);
        const page = await browser.newPage();
        const feed = await snapshotFeed(page, "/api/purchase/events", null);
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(h.url);
            await enterTicketPlus(page);
            const listHeader = page.getByRole("heading", { name: "活動列表", exact: true }).locator("..");
            await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
            await assertJoined(listHeader, listHeader.locator("xpath=following-sibling::*[1]"));
            assert.equal(await listHeader.getByRole("button", { name: "新增活動", exact: true }).count(), 1);
            if (width === 390) {
                assert(
                    await page.locator("#activities").evaluate(el => {
                        const viewport = el.closest("table")!.parentElement!;
                        return (
                            getComputedStyle(viewport).overflowX === "auto" &&
                            viewport.scrollWidth > viewport.clientWidth
                        );
                    }),
                );
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            }
            await page.screenshot({ path: `/tmp/ticket-restored-list-${width}.png`, fullPage: true });
            await page.getByRole("button", { name: "編輯活動", exact: true }).click();
            const nav = page.getByRole("navigation", { name: "設定步驟" });
            for (const step of ["活動與順位", "確認與開始", "執行狀態"]) {
                await nav.getByRole("button", { name: step, exact: true }).click();
                await page.mouse.move(0, 0);
                const content = nav.locator("xpath=following-sibling::*[1]");
                await assertJoined(nav, content);
                assert.equal(await content.evaluate(el => getComputedStyle(el).borderTopLeftRadius), "0px");
                const active = nav.locator('[aria-current="step"]');
                assert.equal(await active.innerText(), step);
                assert(await active.evaluate(el => Number.parseFloat(getComputedStyle(el).borderBottomWidth) > 0));
                assert.notEqual(
                    await active.evaluate(el => getComputedStyle(el).borderBottomColor),
                    "rgba(0, 0, 0, 0)",
                );
                assert.equal(await active.evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            }
            await nav.getByRole("button", { name: "活動與順位", exact: true }).click();
            await page.mouse.move(0, 0);
            await page.screenshot({ path: `/tmp/ticket-restored-tabs-${width}.png`, fullPage: true });
        }
        // 真正顯示執行內容時，也要沿用相同接縫，而不影響獨立狀態頁。
        feed.publish({
            id: "layout-run",
            platform: "ticketplus",
            activityId: record.id,
            activityName: apiActivity.eventName,
            flowType: "purchase",
            status: "running",
            occupied: true,
            browserOpen: true,
            canCloseBrowser: false,
            events: [],
            historyTruncated: false,
        });
        const nav = page.getByRole("navigation", { name: "設定步驟" });
        await nav.getByRole("button", { name: "執行狀態", exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").count(), 1));
        await assertJoined(nav, nav.locator("xpath=following-sibling::*[1]"));
    } finally {
        await browser.close();
        await h.dispose();
    }
});
