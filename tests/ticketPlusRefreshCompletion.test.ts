import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { refreshTicketPlusTickets } from "../src/platforms/ticketplus/ticketRefresh.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { installQuantityFixture, quantityState } from "./fixtures/ticketplus/quantityPage.js";

import { installRefreshExample } from "./fixtures/ticketplus/refreshPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};

async function withPage(run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { count: 0 });
        await run(page);
        const { clicks } = await quantityState(page);
        for (const [key, count] of Object.entries(clicks)) {
            if (key !== "refresh") assert.equal(count, 0, key);
        }
    } finally {
        await browser.close();
    }
}

async function restoreExample(page: Page) {
    await page.evaluate(() => window.refreshExample.restoreData());
    await page.evaluate(() => window.refreshExample.restoreButton());
}

test("TicketPlus 更新完成：完整過渡後庫存不變也能完成，按鈕可重建", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        assert.equal(await page.locator(".count-button").count(), 0);
        await restoreExample(page);
        const result = await pending;
        assert.equal(result.kind, "completed");
        assert.equal(await page.evaluate(() => "ticketPilotRefresh" in window), false);
        assert.equal(result.clickAttempted, true);
        assert.equal(
            await page
                .locator('[data-fixture="student"]')
                .innerText()
                .then(text => text.includes("剩餘 14")),
            true,
        );
        assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "0" });
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

// 實站約 140ms 空窗、再約 500ms 資料已恢復但按鈕未回；保留超過一次 50ms 輪詢，讓輪詢確實讀到這兩段。
async function restoreLikeLiveSite(page: Page) {
    await page.waitForTimeout(150);
    await page.evaluate(() => window.refreshExample.restoreData());
    await page.waitForTimeout(150);
    await page.evaluate(() => window.refreshExample.restoreButton());
}

test("TicketPlus 更新完成：實站空窗保留計數器、售完列暫時出現計數器，仍可完成", async () => {
    await withPage(async page => {
        await installRefreshExample(page, "live");
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        assert.equal(await page.locator(".count-button").count(), 3);
        assert.equal(await page.getByText("已售完", { exact: true }).count(), 0);
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "completed");
        assert.equal(await page.getByText("已售完", { exact: true }).count(), 1);
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：實站空窗中計數器張數非零，以殘留張數停止且不補按", async () => {
    await withPage(async page => {
        await installRefreshExample(page, "live");
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => {
            document.querySelector('[data-fixture="student"] .count-button > div')!.textContent = "1";
        });
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.reason, "remaining-quantity");
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：空窗只消失庫存或只消失已售完，不算空窗而停止", async () => {
    for (const mode of ["keep-status", "keep-sold-out"] as const) {
        await withPage(async page => {
            await installRefreshExample(page, mode);
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            await page.waitForFunction(() => window.refreshExample.phase === "partial");
            await restoreLikeLiveSite(page);
            const result = await pending;
            assert.equal(result.kind, "stopped", mode);
            if (result.kind === "stopped") assert.equal(result.reason, "unexpected-page", mode);
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        });
    }
});

test("TicketPlus 更新完成：空窗中一列有兩組計數器，不算空窗而停止", async () => {
    await withPage(async page => {
        await installRefreshExample(page, "live");
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => {
            const counter = document.querySelector('[data-fixture="student"] .count-button')!;
            counter.after(counter.cloneNode(true));
        });
        await restoreLikeLiveSite(page);
        const result = await pending;
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.reason, "unexpected-page");
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：沒有過渡或只有按鈕冷卻，不可回報完成", async () => {
    for (const mode of ["none", "button-only"] as const) {
        await withPage(async page => {
            if (mode === "button-only") await installRefreshExample(page, mode);
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 800 });
            if (mode === "button-only") {
                await page.waitForFunction(() => window.refreshExample.phase === "partial");
                await page.evaluate(() => window.refreshExample.restoreButton());
            }
            const result = await pending;
            assert.equal(result.kind, "stopped");
            assert.equal(result.clickAttempted, true);
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        });
    }
});

test("TicketPlus 更新完成：資料先恢復但按鈕未恢復，不能提前完成", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 800 });
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => window.refreshExample.restoreData());
        const result = await pending;
        assert.equal(result.kind, "stopped");
        assert.equal(await page.getByRole("button", { name: "更新票數", exact: true }).count(), 0);
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：已停止後才恢復畫面，結果仍停止且不補按", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        const controller = new AbortController();
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(controller.signal));
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        controller.abort();
        const result = await pending;
        await restoreExample(page);
        assert.equal(result.kind, "stopped");
        if (result.kind === "stopped") assert.equal(result.stopReason, "user-stop");
        assert.equal(await page.evaluate(() => "ticketPilotRefresh" in window), false);
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：第二次沒有過渡，不能沿用第一次的證據", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        const first = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await restoreExample(page);
        assert.equal((await first).kind, "completed");
        await page.evaluate(() => {
            window.refreshExample.enabled = false;
        });
        const second = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 800 });
        assert.equal(second.kind, "stopped");
        assert.equal(second.clickAttempted, true);
        assert.equal((await quantityState(page)).clicks.refresh, 2);
    });
});

test("TicketPlus 更新完成：按鈕先恢復但資料仍缺漏，不可回報完成", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 800 });
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => window.refreshExample.restoreButton());
        const result = await pending;
        assert.equal(result.kind, "stopped");
        assert.equal(await page.locator(".count-button").count(), 0);
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});

test("TicketPlus 更新完成：過渡後場次錯誤、彈窗或非零張數皆停止", async () => {
    for (const mutation of ["session", "dialog", "quantity"] as const) {
        await withPage(async page => {
            await installRefreshExample(page);
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            await page.waitForFunction(() => window.refreshExample.phase === "partial");
            await page.evaluate(mutation => {
                window.refreshExample.restoreData();
                window.refreshExample.restoreButton();
                if (mutation === "session") history.replaceState(null, "", "/order/event-fixture/another");
                if (mutation === "dialog")
                    document.body.insertAdjacentHTML("beforeend", '<div role="dialog">未知錯誤</div>');
                if (mutation === "quantity")
                    document.querySelector('[data-fixture="student"] .count-button > div')!.textContent = "1";
            }, mutation);
            const result = await pending;
            assert.equal(result.kind, "stopped");
            assert.equal(result.clickAttempted, true);
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        });
    }
});

test("TicketPlus 更新完成：輪詢錯過整段短暫過渡，監測仍保留本次證據", async context => {
    await withPage(async page => {
        await installRefreshExample(page);
        const original = page.evaluate.bind(page);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            const request = args[1] as { action?: string } | undefined;
            if (request?.action === "read") {
                entered();
                await held;
            }
            return original(...args);
        });
        try {
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            await started;
            await page.waitForFunction(() => window.refreshExample.phase === "partial");
            await restoreExample(page);
            assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "0" });
            release();
            assert.equal((await pending).kind, "completed");
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        } finally {
            release();
            mock.mock.restore();
        }
    });
});

test("TicketPlus 更新完成：visibility hidden 同名按鈕不造成歧義或遮蔽過渡", async () => {
    await withPage(async page => {
        await installRefreshExample(page);
        await page.evaluate(() => {
            const copy = document.querySelector('[data-fixture-action="refresh"]')!.cloneNode(true) as HTMLElement;
            copy.style.visibility = "hidden";
            document.body.append(copy);
        });
        const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await restoreExample(page);
        assert.equal((await pending).kind, "completed");
        assert.equal((await quantityState(page)).clicks.refresh, 1);
    });
});
