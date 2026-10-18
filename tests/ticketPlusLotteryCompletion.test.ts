import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPageWithMarkers } from "../src/platforms/ticketplus/pageState.js";
import { readTicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";
import { readTicketPlusLotteryInput } from "../src/platforms/ticketplus/lotteryInput.js";
import { completeTicketPlusLottery } from "../src/platforms/ticketplus/lotteryCompletion.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { purchaseInformation } from "./fixtures/ticketplus/informationSubmitPage.js";
import {
    fakeParticipant,
    lotteryBehavior,
    lotteryInputPage,
    mixedRegisterPage,
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
    pages: { input?: string; register?: string } = {},
) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => {
            const path = new URL(route.request().url()).pathname;
            const body =
                path === inputPath
                    ? (pages.input ?? lotteryInputPage(options)) + lotteryBehavior(mode, registerPath)
                    : path === registerPath
                      ? (pages.register ?? registerPage) + lotteryBehavior(mode, registerPath)
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

test("抽選參加者：編輯表單開著時參加者區塊仍算一個，讀成填寫中而非可送出的輸入頁", async () => {
    await withLottery({ rows: ["filled"], dialog: "edit" }, "to-register", async page => {
        const read = await readTicketPlusPageWithMarkers(page);
        assert.equal(read.markers?.participantSections, 1);
        assert.equal(read.markers?.dialogs, 1);
        assert.deepEqual(readTicketPlusLotteryInput(read, session), { kind: "editing" });
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

const none = { terms: 0, link: 0, next: 0, register: 0, cancel: 0, edit: 0, back: 0 };

test("抽選收尾：參加者已填時勾條款一次、按下一步一次，停在確認登記前", async () => {
    await withLottery({ rows: ["filled"] }, "to-register", async (page, counts) => {
        const result = await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl());
        assert.deepEqual(result, { outcome: "registration-ready" });
        assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
        // 原始快照也不得帶出參加者姓名或證件號碼
        await page.goBack();
        const raw = JSON.stringify(await readTicketPlusDom(page));
        assert(!raw.includes(fakeParticipant.name) && !raw.includes(fakeParticipant.id));
    });
    // 條款已勾時不再點
    await withLottery({ rows: ["filled", "filled"], termsChecked: true }, "to-register", async (page, counts) => {
        assert.deepEqual(await completeTicketPlusLottery(page, session, 2, new TicketPlusRunControl()), {
            outcome: "registration-ready",
        });
        assert.deepEqual(await counts(), { ...none, next: 1 });
    });
});

test("抽選收尾：每種點擊前的不符各回自己的原因，且零點擊", async () => {
    for (const [options, quantity, reason] of [
        [{ rows: ["filled"], dialog: "edit" }, 1, "dialog-open"],
        [{ rows: ["filled"], dialog: "close-confirm" }, 1, "dialog-open"],
        [{ rows: ["filled", "filled"] }, 1, "participant-count"],
        [{ rows: ["filled", "empty"] }, 2, "participant-incomplete"],
    ] as const) {
        await withLottery({ ...options, rows: [...options.rows] }, "to-register", async (page, counts) => {
            assert.deepEqual(await completeTicketPlusLottery(page, session, quantity, new TicketPlusRunControl()), {
                outcome: "stopped",
                reason,
            });
            assert.deepEqual(await counts(), none);
        });
    }
    // 別的場次不是輸入資料頁
    await withLottery({ rows: ["filled"] }, "to-register", async (page, counts) => {
        assert.deepEqual(
            await completeTicketPlusLottery(
                page,
                { ...session, sessionId: "session-A" },
                1,
                new TicketPlusRunControl(),
            ),
            { outcome: "stopped", reason: "not-input-page" },
        );
        assert.deepEqual(await counts(), none);
    });
});

test("抽選收尾：按下一步後沒到確認登記頁，回報未確認且不重按", async () => {
    await withLottery({ rows: ["filled"] }, "stay", async (page, counts) => {
        assert.deepEqual(
            await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl(), { timeoutMs: 800 }),
            { outcome: "unknown", reason: "checkout-not-reached" },
        );
        assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
    });
});

test("抽選參加者：徽章與欄位兩個條件都要成立才算已填", async () => {
    await withLottery({ rows: ["badge-only", "grey-text", "filled"] }, "to-register", async page => {
        const state = readTicketPlusLotteryInput(await readTicketPlusPageWithMarkers(page), session);
        assert.deepEqual(state, {
            kind: "input",
            applicants: [{ filled: false }, { filled: false }, { filled: true }],
        });
    });
});

test("抽選參加者：編輯表單或關閉表單確認開著時是填寫中，不當成頁面改變", async () => {
    for (const dialog of ["edit", "close-confirm"] as const) {
        await withLottery({ rows: ["empty"], dialog }, "to-register", async page => {
            assert.deepEqual(readTicketPlusLotteryInput(await readTicketPlusPageWithMarkers(page), session), {
                kind: "editing",
            });
        });
    }
    // 未知彈窗仍是其他狀態
    await withLottery({ rows: ["empty"] }, "to-register", async page => {
        await page.evaluate(() =>
            document.body.insertAdjacentHTML(
                "beforeend",
                '<div role="dialog" class="v-dialog__content"><div class="v-dialog">網站維護中<button>確定</button></div></div>',
            ),
        );
        assert.deepEqual(readTicketPlusLotteryInput(await readTicketPlusPageWithMarkers(page), session), {
            kind: "other",
        });
    });
});

test("抽選收尾：購票資料頁、下一步不可用、停止或期限，皆在點擊前停止", async () => {
    // 沒有參加者資訊的購票資料頁
    await withLottery(
        {},
        "to-register",
        async (page, counts) => {
            assert.deepEqual(await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl()), {
                outcome: "stopped",
                reason: "not-input-page",
            });
            assert.deepEqual(await counts(), none);
        },
        { input: purchaseInformation() },
    );

    // 條款已勾但下一步仍停用
    await withLottery({ rows: ["filled"], termsChecked: true }, "to-register", async (page, counts) => {
        await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('[data-lottery="next"]')!.setAttribute("disabled", ""),
        );
        assert.deepEqual(await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl()), {
            outcome: "stopped",
            reason: "next-unavailable",
        });
        assert.deepEqual(await counts(), none);
    });

    // 已要求停止
    await withLottery({ rows: ["filled"] }, "to-register", async (page, counts) => {
        const abort = new AbortController();
        abort.abort();
        assert.deepEqual(await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl(abort.signal)), {
            outcome: "stopped",
            reason: "user-stopped",
        });
        assert.deepEqual(await counts(), none);
    });
});

test("抽選收尾：下一步後到的頁面同時有前往付款，不當成確認登記頁", async () => {
    await withLottery(
        { rows: ["filled"] },
        "to-register",
        async (page, counts) => {
            assert.deepEqual(
                await completeTicketPlusLottery(page, session, 1, new TicketPlusRunControl(), { timeoutMs: 800 }),
                { outcome: "unknown", reason: "checkout-not-reached" },
            );
            assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
        },
        { register: mixedRegisterPage },
    );
});
