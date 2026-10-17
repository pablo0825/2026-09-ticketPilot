import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { confirmTicketPlusSeats } from "../src/platforms/ticketplus/seatConfirmation.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import { observedSeat, seatBehavior, seatConfirmPage } from "./fixtures/ticketplus/seatConfirmPage.js";
import type { SeatNextMode, SeatRow } from "./fixtures/ticketplus/seatConfirmPage.js";
import { readyInformation } from "./fixtures/ticketplus/submissionPage.js";

const seatPath = "/confirmSeat/event-fixture/session-B";
const informationPath = "/confirm/event-fixture/session-B";
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "C 區", quantity: 1 },
};
const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
};

async function withSeatPage(
    rows: SeatRow[],
    mode: SeatNextMode,
    run: (page: Page, counts: () => Promise<{ next: number; cancel: number }>) => Promise<void>,
) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => {
            const path = new URL(route.request().url()).pathname;
            const body =
                path === seatPath ? seatConfirmPage(rows) + seatBehavior(mode, informationPath) : readyInformation;
            return route.fulfill({ contentType: "text/html; charset=utf-8", body });
        });
        await page.goto("https://ticketplus.com.tw" + seatPath);
        const counts = () =>
            page.evaluate(() => ({
                next: Number(sessionStorage.getItem("seat-next") ?? "0"),
                cancel: Number(sessionStorage.getItem("seat-cancel") ?? "0"),
            }));
        await run(page, counts);
    } finally {
        await browser.close();
    }
}

test("確認選位：票區與張數相符時按一次下一步，抵達同場次資料頁", async () => {
    await withSeatPage([observedSeat], "to-information", async (page, counts) => {
        const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl());
        assert.equal(result.outcome, "confirmed");
        if (result.outcome !== "confirmed") assert.fail();
        assert.equal(result.information.kind, "information");
        assert.deepEqual(await counts(), { next: 1, cancel: 0 });
    });
});

test("確認選位：票區不符、張數不符時零點擊停止", async () => {
    for (const rows of [
        [{ ...observedSeat, area: "B 區" }],
        [observedSeat, { ...observedSeat, position: "25 排 8 號" }],
    ]) {
        await withSeatPage(rows, "to-information", async (page, counts) => {
            const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl());
            assert.deepEqual(result, { outcome: "stopped", reason: "seat-mismatch" });
            assert.deepEqual(await counts(), { next: 0, cancel: 0 });
        });
    }
});

test("確認選位：按下一步後停留原頁，回報未確認且不再按", async () => {
    await withSeatPage([observedSeat], "stay", async (page, counts) => {
        const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl(), {
            timeoutMs: 800,
        });
        assert.deepEqual(result, { outcome: "unknown", reason: "seat-confirm-unconfirmed" });
        assert.deepEqual(await counts(), { next: 1, cancel: 0 });
    });
});

test("確認選位：已停止時不點擊，回報使用者停止", async () => {
    await withSeatPage([observedSeat], "to-information", async (page, counts) => {
        const abort = new AbortController();
        abort.abort();
        const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl(abort.signal));
        assert.deepEqual(result, { outcome: "stopped", reason: "user-stopped" });
        assert.deepEqual(await counts(), { next: 0, cancel: 0 });
    });
});

test("確認選位：兩張相符時按一次下一步；別的場次或下一步不唯一時零點擊", async () => {
    // 兩張同票區相符
    await withSeatPage(
        [observedSeat, { ...observedSeat, position: "25 排 8 號" }],
        "to-information",
        async (page, counts) => {
            const result = await confirmTicketPlusSeats(
                page,
                { ...settings, target: { ...settings.target, quantity: 2 } },
                session,
                new TicketPlusRunControl(),
            );
            assert.equal(result.outcome, "confirmed");
            assert.deepEqual(await counts(), { next: 1, cancel: 0 });
        },
    );

    // 網址是別的場次
    await withSeatPage([observedSeat], "to-information", async (page, counts) => {
        const result = await confirmTicketPlusSeats(
            page,
            settings,
            { ...session, sessionId: "session-A" },
            new TicketPlusRunControl(),
        );
        assert.deepEqual(result, { outcome: "stopped", reason: "seat-mismatch" });
        assert.deepEqual(await counts(), { next: 0, cancel: 0 });
    });

    // 讀取後又多出一顆下一步：點擊前重讀發現不唯一
    await withSeatPage([observedSeat], "to-information", async (page, counts) => {
        await page.evaluate(() => {
            const original = document.querySelector('[data-seat="next"]')!;
            original.insertAdjacentHTML(
                "afterend",
                '<button type="button" class="nextBtn v-btn" data-seat="next">下一步</button>',
            );
        });
        const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl());
        assert.equal(result.outcome, "stopped");
        assert.deepEqual(await counts(), { next: 0, cancel: 0 });
    });
});

test("確認選位：下一步停用時零點擊，回報按鈕無法使用而非座位不符", async () => {
    await withSeatPage([observedSeat], "to-information", async (page, counts) => {
        await page.evaluate(() => document.querySelector('[data-seat="next"]')!.setAttribute("disabled", ""));
        const result = await confirmTicketPlusSeats(page, settings, session, new TicketPlusRunControl());
        assert.deepEqual(result, { outcome: "stopped", reason: "button-unavailable" });
        assert.deepEqual(await counts(), { next: 0, cancel: 0 });
    });
});
