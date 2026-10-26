import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { refreshTicketPlusTickets } from "../../../src/platforms/ticketplus/ticketRefresh.js";
import { TicketPlusRunControl } from "../../../src/platforms/ticketplus/runControl.js";
import { installQuantityFixture, quantityState } from "../../fixtures/ticketplus/quantityPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};

test("更新監測：安裝延遲至期限後不點擊，也不留下監測", async context => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { count: 0 });
        const original = page.evaluate.bind(page);
        let installEntered = false;
        const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            const request = args[1] as { action?: string; expiresAt?: number } | undefined;
            if (request?.action === "install") {
                installEntered = true;
                await new Promise(resolve => setTimeout(resolve, Math.max(0, request.expiresAt! - Date.now()) + 20));
            }
            return original(...args);
        });
        const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 1000 });
        mock.mock.restore();
        assert.equal(installEntered, true);
        assert.equal(result.kind, "stopped");
        assert.equal(result.clickAttempted, false);
        assert.equal((await quantityState(page)).clicks.refresh, 0);
        assert.equal(await page.evaluate(() => "ticketPilotRefresh" in window), false);
    } finally {
        await browser.close();
    }
});

test("更新監測：點擊失敗會清理，不留下等待使用者點擊的監測", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { count: 0 });
        await page.evaluate(() =>
            document.body.insertAdjacentHTML("beforeend", '<div style="position:fixed;inset:0;z-index:9999"></div>'),
        );
        const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), {
            clickTimeoutMs: 100,
        });
        assert.equal(result.reason, "click-failed");
        assert.equal((await quantityState(page)).clicks.refresh, 0);
        assert.equal(await page.evaluate(() => "ticketPilotRefresh" in window), false);
    } finally {
        await browser.close();
    }
});
