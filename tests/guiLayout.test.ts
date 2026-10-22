import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Locator } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

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
            const platformHeader = page.getByRole("heading", { name: "購票平台", exact: true }).locator("..");
            await assertJoined(platformHeader, page.locator("#platformHome"));
            assert.equal(
                await platformHeader.evaluate(el => getComputedStyle(el.parentElement!).borderTopStyle),
                "solid",
            );
            await page.screenshot({ path: `/tmp/ticket-restored-home-${width}.png`, fullPage: true });
            await page.locator("#selectTicketPlus").click();
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

test("Klook 四個共用分頁接合外框，切頁保留草稿與紀錄閱讀位置", async () => {
    const h = await apiHarness();
    const browser = await chromium.launch();
    try {
        const activity = {
            platform: "klook",
            eventName: "Klook 版面測試",
            eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
            fallbackMode: "STRICT",
            excludeKeywords: [],
            targets: [{ date: "2026-11-02", time: "19:30", area: "B區", quantity: 1, adjacent: false }],
        };
        const record = await (await h.request("/api/activities", activity)).json();
        const contactResponse = await fetch(h.url + "/api/contact", {
            method: "PUT",
            headers: h.headers,
            body: JSON.stringify({
                firstName: "Test",
                lastName: "Fixture",
                regionLabel: "台灣 (+886)",
                phone: "0912345678",
                email: "fixture@example.com",
            }),
        });
        assert.equal(contactResponse.status, 200);
        const page = await browser.newPage();
        const feed = await snapshotFeed(page, "/api/purchase/events", null);
        await page.goto(h.url);
        await page.locator("#selectKlook").click();
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        const nav = page.getByRole("navigation", { name: "設定步驟" });
        await nav.waitFor();
        assert.deepEqual(await nav.getByRole("button").allTextContents(), [
            "活動與順位",
            "聯絡資料",
            "確認與開始",
            "執行狀態",
        ]);
        await page.locator("#eventName").fill("未存草稿");
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 900 });
            for (const [index, step] of ["活動與順位", "聯絡資料", "確認與開始", "執行狀態"].entries()) {
                await nav.getByRole("button", { name: step, exact: true }).click();
                await assertJoined(nav, page.locator(`#step${index + 1} > [data-tailwind]`));
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                await page.screenshot({ path: `/tmp/klook-page-${index + 1}-${width}.png`, fullPage: true });
                if (index === 0) {
                    const date = await page.locator('[name="date"]').boundingBox();
                    const adjacent = page.getByRole("group", { name: "要求連位", exact: true });
                    const left = await adjacent.boundingBox();
                    assert(date && left);
                    assert(Math.abs(date.x - left.x) < 2);
                    await page.locator("#bundleEnabled").check();
                    const bundle = await page.locator('[name="bundle"]').boundingBox();
                    const right = await adjacent.boundingBox();
                    assert(bundle && right);
                    if (width === 1280) {
                        assert(bundle.width > right.width * 3);
                        assert(right.x > bundle.x + bundle.width);
                    } else {
                        assert(right.y > bundle.y + bundle.height);
                    }
                    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
                    await page.screenshot({ path: `/tmp/klook-bundle-${width}.png`, fullPage: true });
                    await page.locator("#bundleEnabled").uncheck();
                }
            }
        }
        await nav.getByRole("button", { name: "活動與順位", exact: true }).click();
        assert.equal(await page.locator("#eventName").inputValue(), "未存草稿");
        await page.locator("#eventName").fill(activity.eventName);
        const run = {
            id: "klook-layout-run",
            platform: "klook",
            activityId: record.id,
            activityName: activity.eventName,
            status: "running",
            occupied: true,
            browserOpen: true,
            canCloseBrowser: false,
            historyTruncated: false,
            events: Array.from({ length: 60 }, (_, index) => ({
                at: new Date().toISOString(),
                event: { type: "log", message: `紀錄 ${index} ${"測試文字".repeat(20)}` },
            })),
        };
        let starts = 0;
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            starts++;
            await route.fulfill({ json: run });
        });
        await nav.getByRole("button", { name: "確認與開始", exact: true }).click();
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        const logs = page.locator("#logs");
        await logs.waitFor();
        await logs.evaluate(el => {
            el.scrollTop = 0;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await nav.getByRole("button", { name: "活動與順位", exact: true }).click();
        run.events.push({ at: new Date().toISOString(), event: { type: "log", message: "切頁後的新紀錄" } });
        feed.publish(run);
        await eventually(async () => assert.match(await logs.innerText(), /切頁後的新紀錄/));
        await nav.getByRole("button", { name: "執行狀態", exact: true }).click();
        assert.equal(await logs.evaluate(el => el.scrollTop), 0);
        assert.equal(starts, 1);
        assert.equal(await page.getByRole("button", { name: "停止購票" }).count(), 0);
    } finally {
        await browser.close();
        await h.dispose();
    }
});
