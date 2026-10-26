import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { startLocalServer } from "../../../src/server/server.js";
import { apiActivity } from "../../fixtures/ticketplus/apiHarness.js";
import { enterTicketPlus } from "../../fixtures/guiTestHelpers.js";

async function fixture(work: (page: Page, starts: string[]) => Promise<void>, settings: unknown) {
    const directory = await mkdtemp(join(tmpdir(), "ticket-summary-layout-"));
    const store = new ActivityStore(join(directory, "events"));
    let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        await store.save(settings);
        service = await startLocalServer(store, { runDirectory: join(directory, "runtime") });
        browser = await chromium.launch();
        const page = await browser.newPage();
        const starts: string[] = [];
        const paths: string[] = [];
        page.on("request", request => paths.push(new URL(request.url()).pathname));
        // 排版測試不執行購票；意外啟動仍會被記錄並令測試失敗。
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            starts.push(route.request().url());
            await route.abort();
        });
        await page.goto(service.url);
        await enterTicketPlus(page);
        await work(page, starts);
        assert(!paths.includes("/api/contact"), "TicketPlus 不得讀寫 Klook 聯絡設定");
    } finally {
        try {
            await browser?.close();
        } finally {
            try {
                await service?.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    }
}
async function edit(page: Page) {
    await page.getByRole("button", { name: "編輯活動", exact: true }).click();
    await page.getByRole("button", { name: "活動與順位", exact: true }).waitFor();
}
async function review(page: Page) {
    await page.getByRole("button", { name: "確認與開始", exact: true }).click();
    await page.getByRole("region", { name: "活動摘要" }).waitFor();
}

test("TicketPlus 摘要：逐列呈現順位對應與活動連結，手機版表格可捲動", async () => {
    await fixture(
        async (page, starts) => {
            await edit(page);
            await review(page);
            const table = page.getByRole("region", { name: "購票順位", exact: true });
            const rows = table.locator("tbody tr");
            assert.deepEqual(await rows.nth(0).getByRole("cell").allTextContents(), [
                "1",
                "2026-10-30",
                "20:00",
                "預售票",
                "2",
            ]);
            assert.deepEqual(await rows.nth(1).getByRole("cell").allTextContents(), [
                "2",
                "2026-10-31",
                "18:30",
                "學生票",
                "1",
            ]);
            const link = page.getByRole("link", { name: apiActivity.eventUrl, exact: true });
            assert.equal(await link.getAttribute("href"), apiActivity.eventUrl);
            assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await table.evaluate(element => getComputedStyle(element).overflowX), "auto");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
            assert.equal(starts.length, 0);
        },
        {
            ...apiActivity,
            targets: [...apiActivity.targets, { date: "2026-10-31", time: "18:30", ticketType: "學生票", quantity: 1 }],
        },
    );
});
