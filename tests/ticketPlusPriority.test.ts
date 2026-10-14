import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { chromium } from "playwright";
import { selectTicketPlusPriority } from "../src/platforms/ticketplus/ticketPriority.js";
import type { TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";
import { installQuantityFixture, quantityPage, quantityState } from "./fixtures/ticketplus/quantityPage.js";
import { presale } from "./fixtures/ticketplus/pages.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [
        { date: "2026-10-30", time: "20:00", ticketType: "身障票", quantity: 1 },
        { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
        { date: "2026-10-30", time: "20:00", ticketType: "學生票", quantity: 1 },
    ],
};
const identity = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
};
const options = { timeoutMs: 5000, changeTimeoutMs: 300, pollIntervalMs: 20 };
const zero = { studentPlus: 0, studentMinus: 0, presalePlus: 0, presaleMinus: 0, next: 0, refresh: 0, other: 0 };

test("順位：明確售完才略過，第二順位調整兩張；第一順位原有張數保留差額行為", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page);
        const selected = await selectTicketPlusPriority(page, settings, identity, options);
        assert.equal(selected.priorityIndex, 1);
        assert.equal(selected.selection.target.ticketType, "預售票");
        assert.deepEqual((await quantityState(page)).clicks, { ...zero, presalePlus: 2 });
        for (const [count, plus, minus] of [
            [1, 1, 0],
            [2, 0, 0],
            [3, 0, 1],
        ]) {
            await installQuantityFixture(page, { count });
            await selectTicketPlusPriority(
                page,
                { ...settings, targets: settings.targets.slice(1) },
                identity,
                options,
            );
            assert.deepEqual((await quantityState(page)).clicks, { ...zero, presalePlus: plus, presaleMinus: minus });
        }
    } finally {
        await browser.close();
    }
});

test("順位：缺票名、歧義、未知頁、他票有張數、全部售完均零操作", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        for (const [html, targets, reason, studentCount] of [
            [quantityPage, [{ ...settings.targets[0]!, ticketType: "A區" }, settings.targets[1]!], "ticket-missing", 0],
            [quantityPage + presale.replace("<div>1</div>", "<div>0</div>"), settings.targets, "ticket-ambiguous", 0],
            [quantityPage.replace("剩餘 14", "狀態未知"), settings.targets, "unexpected-page", 0],
            [quantityPage, settings.targets, "extra-tickets", 1],
            [quantityPage, [settings.targets[0]!, settings.targets[0]!], "all-targets-sold-out", 0],
        ] as const) {
            await installQuantityFixture(page, { html, studentCount });
            await assert.rejects(
                selectTicketPlusPriority(page, { ...settings, targets: [...targets] }, identity, options),
                (error: any) => error.reason === reason,
            );
            assert.deepEqual((await quantityState(page)).clicks, zero);
        }
    } finally {
        await browser.close();
    }
});

test("順位：按鈕停用或加票部分失敗不能改買第三順位", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        for (const partial of [false, true]) {
            await installQuantityFixture(page, { disablePlus: !partial, behavior: partial ? "partial" : "normal" });
            await assert.rejects(
                selectTicketPlusPriority(page, settings, identity, options),
                (error: any) => error.reason === (partial ? "change-timeout" : "button-unavailable"),
            );
            assert.deepEqual((await quantityState(page)).clicks, { ...zero, presalePlus: partial ? 2 : 0 });
        }
    } finally {
        await browser.close();
    }
});

test("順位：候補挑選後到調張數前出現一張，不可當成可補足的差額", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page);
        const evaluate = page.evaluate.bind(page);
        let reads = 0;
        const hook = mock.method(page, "evaluate", async (...args: any[]) => {
            const result = await (evaluate as any)(...args);
            if (++reads === 2)
                await evaluate(() => {
                    document.querySelector('[data-fixture="presale"] .count-button > div')!.textContent = "1";
                });
            return result;
        });
        try {
            await assert.rejects(
                selectTicketPlusPriority(page, settings, identity, options),
                (error: any) => error.reason === "quantity-changed",
            );
        } finally {
            hook.mock.restore();
        }
        assert.deepEqual((await quantityState(page)).clicks, zero);
    } finally {
        await browser.close();
    }
});

test("順位：場次不符或唯讀逾時後不再操作", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page);
        await page.evaluate(() => history.replaceState(null, "", "/order/event-fixture/session-other"));
        await assert.rejects(
            selectTicketPlusPriority(page, settings, identity, options),
            (error: any) => error.reason === "identity-mismatch",
        );
        assert.deepEqual((await quantityState(page)).clicks, zero);
        await page.evaluate(() => history.replaceState(null, "", "/order/event-fixture/session-B"));

        // 讓真實唯讀查詢延遲交回結果；逾時後解開，不能開始調張數。
        const evaluate = page.evaluate.bind(page);
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const hook = mock.method(page, "evaluate", async (...args: any[]) => {
            const result = await (evaluate as any)(...args);
            await gate;
            return result;
        });
        try {
            await assert.rejects(
                selectTicketPlusPriority(page, settings, identity, { timeoutMs: 100 }),
                (error: any) => error.reason === "operation-timeout",
            );
        } finally {
            release();
            hook.mock.restore();
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.deepEqual((await quantityState(page)).clicks, zero);
    } finally {
        await browser.close();
    }
});

test("順位：挑選耗時扣除調張數期限，不替 quantity 重新給完整時間", { timeout: 10_000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { behavior: "partial" });
        // 時鐘只控制期限；頁面仍以真實加票動作更新，第二次加票固定不生效。
        let now = 0;
        let watchdogFired = false;
        const watchdog = setTimeout(() => {
            watchdogFired = true;
            now = 10_000;
        }, 3000);
        const clock = mock.method(performance, "now", () => now);
        const evaluate = page.evaluate.bind(page);
        let reads = 0;
        const hook = mock.method(page, "evaluate", async (...args: any[]) => {
            const result = await (evaluate as any)(...args);
            if (++reads === 2 && !watchdogFired) now = 800;
            if ((await evaluate(() => window.quantityFixture.clicks.presalePlus)) === 2 && !watchdogFired) now = 1100;
            return result;
        });
        try {
            await assert.rejects(
                selectTicketPlusPriority(page, settings, identity, {
                    timeoutMs: 1000,
                    changeTimeoutMs: 2000,
                    pollIntervalMs: 10,
                }),
                (error: any) => error.reason === "operation-timeout",
            );
        } finally {
            hook.mock.restore();
            clock.mock.restore();
            clearTimeout(watchdog);
        }
        assert.equal(watchdogFired, false, "不能等保險期限才停止");
        assert.deepEqual((await quantityState(page)).clicks, { ...zero, presalePlus: 2 });
    } finally {
        await browser.close();
    }
});
