import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { refreshTicketPlusTickets } from "../src/platforms/ticketplus/ticketRefresh.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { readTicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";
import { installRefreshExample } from "./fixtures/ticketplus/refreshPage.js";
import type { RefreshExampleMode } from "./fixtures/ticketplus/refreshPage.js";
import { areaOrder } from "./fixtures/ticketplus/areaPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};

// 票區面板頁（VIP 收合保留內容、A/C 收合、B 展開 0 張）；記錄更新票數與其他按鈕的點擊次數。
async function withAreaPage(mode: RefreshExampleMode, run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: areaOrder() }),
        );
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
        await page.evaluate(() => {
            const counts = { refresh: 0, other: 0 };
            (window as unknown as { buttonClicks: typeof counts }).buttonClicks = counts;
            document.addEventListener(
                "click",
                event => {
                    const button = (event.target as Element).closest("button");
                    if (!button) return;
                    if (button.textContent?.trim() === "更新票數") counts.refresh++;
                    else counts.other++;
                },
                true,
            );
        });
        await installRefreshExample(page, mode);
        await run(page);
    } finally {
        await browser.close();
    }
}

const buttonClicks = (page: Page) =>
    page.evaluate(() => (window as unknown as { buttonClicks: { refresh: number; other: number } }).buttonClicks);

// 依實站時序：標題庫存約空窗 50ms，資料恢復時數字可能改變，按鈕約 500ms 後才回來。
// 輪詢可能錯過這麼短的空窗，完成判斷靠瀏覽器內的監測記錄。
async function restoreLikeLiveSite(page: Page) {
    await page.waitForTimeout(60);
    await page.evaluate(() => {
        window.refreshExample.restoreData();
        const small = Array.from(document.querySelectorAll(".v-expansion-panel-header small")).find(element =>
            element.textContent?.includes("20"),
        );
        if (small) small.textContent = "剩餘 18";
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => window.refreshExample.restoreButton());
}

// 只看瀏覽器內監測：安裝後點更新票數，依實站時序恢復，再讀取這次的空窗證據。
async function monitorEvidence(page: Page) {
    const request = { token: "fixture-token", expiresAt: Date.now() + 5_000 };
    await readTicketPlusDom(page, { ...request, action: "install" });
    await page.getByRole("button", { name: "更新票數", exact: true }).click();
    await page.waitForFunction(() => window.refreshExample.phase === "partial");
    await restoreLikeLiveSite(page);
    return (await readTicketPlusDom(page, { ...request, action: "read" })).refreshEvidence;
}

test("票區更新：所有票區標題的庫存暫時消失再恢復，判定更新完成", async () => {
    await withAreaPage("area", async page => {
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        assert.equal(
            await page.locator(".v-expansion-panel-header small, .v-expansion-panel-header .v-chip").count(),
            0,
        );
        assert.equal(await page.locator(".count-button").count(), 1);
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "completed");
        assert.deepEqual(await buttonClicks(page), { refresh: 1, other: 0 });
    });
});

test("票區更新：只有部分票區標題的庫存消失，不算空窗而停止", async () => {
    await withAreaPage("area-partial", async page => {
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.reason, "unexpected-page");
        assert.deepEqual(await buttonClicks(page), { refresh: 1, other: 0 });
    });
});

test("票區更新：只有按鈕消失、庫存沒有消失過，不能判定完成", async () => {
    await withAreaPage("button-only", async page => {
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 800 });
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => window.refreshExample.restoreButton());
        const result = await pending;
        assert.equal(result.kind, "stopped");
        assert.deepEqual(await buttonClicks(page), { refresh: 1, other: 0 });
    });
});

test("票區更新：空窗中展開票區的張數變成非零，以殘留張數停止", async () => {
    await withAreaPage("area", async page => {
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => {
            document.querySelector(".v-expansion-panel--active .count-button > div")!.textContent = "1";
        });
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.reason, "remaining-quantity");
    });
});

test("票區更新監測：只有所有票區標題的庫存都消失、名稱與計數器不變，才記為空窗", async () => {
    for (const [mode, expected] of [
        ["area", true],
        ["area-partial", false],
        ["area-renamed", false],
        ["area-broken-counter", false],
    ] as const) {
        await withAreaPage(mode, async page => {
            const evidence = await monitorEvidence(page);
            assert.equal(evidence?.clicked, true, mode);
            assert.equal(evidence?.dynamicGap, expected, mode);
        });
    }
});

test("票區更新：空窗中票區改名或計數器不完整，不能判定完成", async () => {
    for (const mode of ["area-renamed", "area-broken-counter"] as const) {
        await withAreaPage(mode, async page => {
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 1_500 });
            await page.waitForFunction(() => window.refreshExample.phase === "partial");
            await restoreLikeLiveSite(page);
            const result = await pending;
            assert.equal(result.kind, "stopped", mode);
            assert.deepEqual(await buttonClicks(page), { refresh: 1, other: 0 });
        });
    }
});

test("票區更新：空窗中收合票區的隱藏張數非零，以殘留張數停止", async () => {
    await withAreaPage("area", async page => {
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => {
            const hidden = document.querySelector(".v-expansion-panel-content[style*='none'] .col-4")!;
            hidden.innerHTML =
                '<div class="count-button"><button type="button"><i class="mdi mdi-minus"></i></button><div>1</div><button type="button"><i class="mdi mdi-plus"></i></button></div>';
        });
        await page.waitForTimeout(150);
        const result = await pending;
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.reason, "remaining-quantity");
    });
});
