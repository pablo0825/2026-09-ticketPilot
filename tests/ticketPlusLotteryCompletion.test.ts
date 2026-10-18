import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPageWithMarkers } from "../src/platforms/ticketplus/pageState.js";
import { readTicketPlusLotteryInput } from "../src/platforms/ticketplus/lotteryInput.js";
import {
    fakeParticipant,
    lotteryBehavior,
    lotteryInputPage,
    registerPage,
} from "./fixtures/ticketplus/lotteryPages.js";
import type { LotteryInputOptions, LotteryNextMode } from "./fixtures/ticketplus/lotteryPages.js";

const inputPath = "/confirm/event-fixture/session-B";
const registerPath = "/checkout/event-fixture/session-B";
const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};

async function withLottery(
    options: LotteryInputOptions,
    mode: LotteryNextMode,
    run: (page: Page, counts: () => Promise<Record<string, number>>) => Promise<void>,
) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => {
            const path = new URL(route.request().url()).pathname;
            const body =
                path === inputPath
                    ? lotteryInputPage(options) + lotteryBehavior(mode, registerPath)
                    : path === registerPath
                      ? registerPage + lotteryBehavior(mode, registerPath)
                      : "<html><body>其他頁面</body></html>";
            return route.fulfill({ contentType: "text/html; charset=utf-8", body });
        });
        await page.goto("https://ticketplus.com.tw" + inputPath);
        const counts = () =>
            page.evaluate(() =>
                Object.fromEntries(
                    ["terms", "link", "next", "register", "cancel", "edit", "back"].map(name => [
                        name,
                        Number(sessionStorage.getItem("lottery-" + name) ?? "0"),
                    ]),
                ),
            );
        await run(page, counts);
    } finally {
        await browser.close();
    }
}

test("抽選參加者：未填與已填列分別讀成 false／true，空白格不影響，且不帶出個資", async () => {
    await withLottery({ rows: ["filled", "empty"] }, "to-register", async page => {
        const read = await readTicketPlusPageWithMarkers(page);
        assert.deepEqual(readTicketPlusLotteryInput(read, session), {
            kind: "input",
            applicants: [{ filled: true }, { filled: false }],
        });
        const serialized = JSON.stringify(read);
        assert(!serialized.includes(fakeParticipant.name));
        assert(!serialized.includes(fakeParticipant.id));
    });
});

test("抽選參加者：編輯表單開著時參加者區塊仍算一個，但不是可送出的輸入頁", async () => {
    await withLottery({ rows: ["filled"], dialog: "edit" }, "to-register", async page => {
        const read = await readTicketPlusPageWithMarkers(page);
        assert.equal(read.markers?.participantSections, 1);
        assert.equal(read.markers?.dialogs, 1);
        assert.deepEqual(readTicketPlusLotteryInput(read, session), { kind: "other" });
    });
});

test("抽選參加者：別的場次、購票資料頁或確認登記頁都不是輸入頁；確認登記頁讀出啟用的確認登記", async () => {
    await withLottery({ rows: ["filled"] }, "to-register", async page => {
        const read = await readTicketPlusPageWithMarkers(page);
        assert.deepEqual(readTicketPlusLotteryInput(read, { ...session, sessionId: "session-A" }), { kind: "other" });

        await page.goto("https://ticketplus.com.tw" + registerPath);
        const register = await readTicketPlusPageWithMarkers(page);
        assert.deepEqual(readTicketPlusLotteryInput(register, session), { kind: "other" });
        assert.deepEqual(register.markers?.registerButtons, [true]);
    });
});
