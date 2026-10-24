import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { selectTicketPlusPriority } from "../src/platforms/ticketplus/ticketPriority.js";
import type { TicketPlusActivitySettings } from "../src/config/platforms/ticketplus/activitySettings.js";
import * as fixture from "./fixtures/ticketplus/areaPage.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [
        { date: "2026-10-30", time: "20:00", ticketType: "VIP 區", quantity: 1 },
        { date: "2026-10-30", time: "20:00", ticketType: "B 區", quantity: 1 },
    ],
};
const identity = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
};
const options = { timeoutMs: 5_000, changeTimeoutMs: 500, pollIntervalMs: 20 };

// 所有票區一開始都收合（從未展開），展開後才出現票種列。
const collapsed = (name: string, stock: string, price: string) =>
    fixture.area({ name, stock, price, state: "collapsed" });
const allCollapsed = fixture.areaOrder([
    collapsed("VIP 區", fixture.remaining(0), "8,900"),
    collapsed("B 區", fixture.selling, "7,000"),
]);
const rows = {
    "VIP 區": fixture.ticketRow("預售票", "8,900", fixture.unavailableText),
    "B 區": fixture.ticketRow("預售票", "7,000", fixture.counter(0)),
};

async function withAreaPage(
    html: string,
    accordion: fixture.AccordionOptions,
    run: (page: Page) => Promise<void>,
): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
        await fixture.installAccordion(page, accordion);
        await run(page);
    } finally {
        await browser.close();
    }
}

test("票區展開：收合的目標先展開一次，等內容畫出後再加票", async () => {
    await withAreaPage(allCollapsed, { rows, contentDelayMs: 150 }, async page => {
        const target = { ...settings, targets: [settings.targets[1]!] };
        const selected = await selectTicketPlusPriority(page, target, identity, options);
        assert.equal(selected.priorityIndex, 0);
        assert.deepEqual(await fixture.areaClicks(page), ["展開:B 區", "B 區+"]);
    });
});

test("票區展開：第一順位展開後是暫無票券，改展開第二順位再加票", async () => {
    await withAreaPage(allCollapsed, { rows }, async page => {
        const selected = await selectTicketPlusPriority(page, settings, identity, options);
        assert.equal(selected.priorityIndex, 1);
        assert.deepEqual(await fixture.areaClicks(page), ["展開:VIP 區", "展開:B 區", "B 區+"]);
    });
});

test("票區展開：目標已展開時不點標題，避免點了反而收合", async () => {
    const html = fixture.areaOrder([
        collapsed("VIP 區", fixture.remaining(0), "8,900"),
        fixture.area({ name: "B 區", stock: fixture.selling, price: "7,000", state: "expanded", rows: [rows["B 區"]] }),
    ]);
    await withAreaPage(html, { rows }, async page => {
        const target = { ...settings, targets: [settings.targets[1]!] };
        await selectTicketPlusPriority(page, target, identity, options);
        assert.deepEqual(await fixture.areaClicks(page), ["B 區+"]);
    });
});

test("票區展開：點了沒有展開時，期限內停止且只點一次、不加票", async () => {
    await withAreaPage(allCollapsed, { rows, ignoreHeaderClicks: true }, async page => {
        const target = { ...settings, targets: [settings.targets[1]!] };
        const started = performance.now();
        await assert.rejects(
            selectTicketPlusPriority(page, target, identity, options),
            (error: any) => error.reason === "area-expansion-failed",
        );
        // 展開等待上限約 3 秒，應早於順位整體期限（5 秒）停止。
        assert.ok(performance.now() - started < 4_500);
        assert.deepEqual(await fixture.areaClicks(page), ["展開:B 區"]);
    });
});

test("票區展開：展開後區內有兩種票時回報歧義，立即停止且不加票", async () => {
    const twoRows = {
        ...rows,
        "B 區":
            fixture.ticketRow("全票", "7,000", fixture.counter(0)) +
            fixture.ticketRow("學生票", "6,000", fixture.counter(0)),
    };
    await withAreaPage(allCollapsed, { rows: twoRows }, async page => {
        const target = { ...settings, targets: [settings.targets[1]!] };
        const started = performance.now();
        await assert.rejects(
            selectTicketPlusPriority(page, target, identity, options),
            (error: any) => error.reason === "ticket-ambiguous",
        );
        assert.ok(performance.now() - started < 1_500);
        assert.deepEqual(await fixture.areaClicks(page), ["展開:B 區"]);
    });
});
