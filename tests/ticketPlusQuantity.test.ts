import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { selectTicketPlusTickets, TicketPlusQuantityError } from "../src/platforms/ticketplus/ticketQuantity.js";
import type { QuantityReason, QuantityStage } from "../src/platforms/ticketplus/ticketQuantity.js";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import { installQuantityFixture, quantityPage, quantityState } from "./fixtures/ticketplus/quantityPage.js";
import type { QuantityFixtureOptions } from "./fixtures/ticketplus/quantityPage.js";
import { presale } from "./fixtures/ticketplus/pages.js";

const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
const identity = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
};
const options = { timeoutMs: 5_000, clickTimeoutMs: 2_000, changeTimeoutMs: 1_000, pollIntervalMs: 20 };
const noClicks = { studentPlus: 0, studentMinus: 0, presalePlus: 0, presaleMinus: 0, next: 0, refresh: 0, other: 0 };

async function withPage(run: (page: Page) => Promise<void>, options: QuantityFixtureOptions = {}): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, options);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function rejectsQuantity(
    promise: Promise<unknown>,
    stage: QuantityStage,
    reason: QuantityReason,
    attemptedClicks: number,
    last?: number,
): Promise<void> {
    await assert.rejects(promise, error => {
        assert(error instanceof TicketPlusQuantityError);
        assert.equal(error.stage, stage);
        assert.equal(error.reason, reason);
        assert.equal(error.attemptedClicks, attemptedClicks);
        assert.equal(error.lastVerifiedQuantity, last);
        return true;
    });
}

test("TicketPlus 張數：0/1/2/3 → 2 各按所需次數，其他控制項零點擊", { timeout: 20_000 }, async () => {
    for (const [start, plus, minus] of [
        [0, 2, 0],
        [1, 1, 0],
        [2, 0, 0],
        [3, 0, 1],
    ]) {
        await withPage(
            async page => {
                const result = await selectTicketPlusTickets(page, settings, identity, options);
                assert.equal(result.sessionId, "session-B");
                assert.deepEqual(
                    result.tickets.map(ticket => ticket.selectedQuantity),
                    [0, 2, 0],
                );
                const state = await quantityState(page);
                assert.deepEqual(state.counts, { student: "0", presale: "2" });
                assert.deepEqual(state.clicks, { ...noClicks, presalePlus: plus, presaleMinus: minus });
            },
            { count: start },
        );
    }
});

test("TicketPlus 張數：全形區名、引號、特殊字元可匹配；半形或名稱前綴不替代", { timeout: 20_000 }, async () => {
    for (const name of ["Ａ區", "預售票 '特別' \"A\" [1]", "A  區"]) {
        await withPage(
            async page => {
                await selectTicketPlusTickets(
                    page,
                    { ...settings, target: { ...settings.target, ticketType: name } },
                    identity,
                    options,
                );
                assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presalePlus: 2 });
            },
            { name },
        );
    }
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(
                    page,
                    { ...settings, target: { ...settings.target, ticketType: "A區" } },
                    identity,
                    options,
                ),
                "before-click",
                "ticket-missing",
                0,
            );
            assert.deepEqual((await quantityState(page)).clicks, noClicks);
        },
        { name: "Ａ區" },
    );
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "before-click",
                "ticket-missing",
                0,
            );
        },
        { name: "預售票優惠票" },
    );
});

test("TicketPlus 張數：相近票名、隱藏副本與重排不點错列", { timeout: 15_000 }, async () => {
    const similar = presale.replace("預售票", "預售票優惠票").replace("<div>1</div>", "<div>0</div>");
    await withPage(
        async page => {
            await page.locator('[data-fixture="presale"]').evaluate(row => row.parentElement!.prepend(row));
            await selectTicketPlusTickets(page, settings, identity, options);
            assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presalePlus: 2 });
        },
        { html: quantityPage + similar + `<div hidden>${presale}</div>` },
    );
});

test("TicketPlus 張數：重複票名、售完、其他票種已有張數皆不操作", { timeout: 15_000 }, async () => {
    const cases: { fixture: QuantityFixtureOptions; reason: QuantityReason }[] = [
        {
            fixture: { html: quantityPage + presale.replace("<div>1</div>", "<div>0</div>") },
            reason: "ticket-ambiguous",
        },
        { fixture: { name: "其他票", html: quantityPage.replace("身障票", "預售票") }, reason: "ticket-sold-out" },
        { fixture: { studentCount: 1 }, reason: "extra-tickets" },
    ];
    for (const item of cases) {
        await withPage(async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "before-click",
                item.reason,
                0,
            );
            assert.deepEqual((await quantityState(page)).clicks, noClicks);
        }, item.fixture);
    }
});

test("TicketPlus 張數：只檢查所需方向，不把庫存数字或plus停用當售完", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await selectTicketPlusTickets(page, settings, identity, options);
            assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presaleMinus: 1 });
        },
        { count: 3, disablePlus: true },
    );
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "before-click",
                "button-unavailable",
                0,
                0,
            );
        },
        { disablePlus: true },
    );
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "before-click",
                "button-unavailable",
                0,
                3,
            );
        },
        { count: 3, disableMinus: true },
    );
    await withPage(
        async page => {
            await selectTicketPlusTickets(page, settings, identity, options);
            assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "2" });
        },
        { html: quantityPage.replace("熱賣中", "剩餘 1") },
    );
});

test("TicketPlus 張數：跳兩張或改到別種票不追趕、不反向還原", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "after-click-attempt",
                "quantity-changed",
                1,
                0,
            );
            const state = await quantityState(page);
            assert.deepEqual(state.counts, { student: "0", presale: "2" });
            assert.deepEqual(state.clicks, { ...noClicks, presalePlus: 1 });
        },
        { behavior: "jump" },
    );
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "after-click-attempt",
                "extra-tickets",
                1,
                0,
            );
            const state = await quantityState(page);
            assert.deepEqual(state.counts, { student: "1", presale: "0" });
            assert.deepEqual(state.clicks, { ...noClicks, presalePlus: 1 });
        },
        { behavior: "wrong-ticket" },
    );
});

test("TicketPlus 張數：無變化與部分完成後逾時不補按，保留最後確認值", { timeout: 15_000 }, async () => {
    for (const behavior of ["none", "partial"] as const) {
        await withPage(
            async page => {
                await rejectsQuantity(
                    selectTicketPlusTickets(page, settings, identity, { ...options, changeTimeoutMs: 100 }),
                    "after-click-attempt",
                    "change-timeout",
                    behavior === "none" ? 1 : 2,
                    behavior === "none" ? 0 : 1,
                );
                const state = await quantityState(page);
                assert.deepEqual(state.counts, { student: "0", presale: behavior === "none" ? "0" : "1" });
                assert.deepEqual(state.clicks, { ...noClicks, presalePlus: behavior === "none" ? 1 : 2 });
                if (behavior === "none") {
                    // 網站逾時後才更新，不代表可自動重跑，也不能讓舊操作再加一張。
                    await page.evaluate(() => window.quantityFixture.acknowledge());
                    assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "1" });
                    assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presalePlus: 1 });
                }
            },
            { behavior },
        );
    }
});

test("TicketPlus 張數：第一下更新未確認時不能送第二下", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            const pending = selectTicketPlusTickets(page, settings, identity, { ...options, changeTimeoutMs: 3_000 });
            await Promise.race([pending, page.waitForFunction(() => window.quantityFixture.readsWhilePending > 0)]);
            const waiting = await quantityState(page);
            assert.deepEqual(waiting.clicks, { ...noClicks, presalePlus: 1 });
            assert.deepEqual(waiting.counts, { student: "0", presale: "0" });
            await page.evaluate(() => window.quantityFixture.acknowledge());
            await pending;
            const final = await quantityState(page);
            assert.deepEqual(final.counts, { student: "0", presale: "2" });
            assert.equal(final.earlyClicks, 0);
            assert.deepEqual(final.clicks, { ...noClicks, presalePlus: 2 });
        },
        { behavior: "delayed" },
    );
});

test("TicketPlus 張數：已確認1卻歸零時停止，不重新計算差額", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, options),
                "after-click-attempt",
                "quantity-changed",
                1,
                1,
            );
            const state = await quantityState(page);
            assert.deepEqual(state.counts, { student: "0", presale: "0" });
            assert.deepEqual(state.clicks, { ...noClicks, presalePlus: 1 });
        },
        { behavior: "reset" },
    );
});

test("TicketPlus 張數：中途換場次或排隊，後續操作全部停止", { timeout: 15_000 }, async () => {
    for (const behavior of ["session-change", "queue"] as const) {
        await withPage(
            async page => {
                await rejectsQuantity(
                    selectTicketPlusTickets(page, settings, identity, options),
                    "after-click-attempt",
                    behavior === "session-change" ? "identity-mismatch" : "unexpected-page",
                    1,
                    0,
                );
                assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presalePlus: 1 });
            },
            { behavior },
        );
    }
});

test("TicketPlus 張數：設定與前階段身分不符、目前場次錯誤皆零點擊", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        await rejectsQuantity(
            selectTicketPlusTickets(page, settings, { ...identity, date: "2026-10-31" }, options),
            "before-click",
            "invalid-session",
            0,
        );
        await rejectsQuantity(
            selectTicketPlusTickets(page, settings, { ...identity, sessionId: "another" }, options),
            "before-click",
            "identity-mismatch",
            0,
        );
        await rejectsQuantity(
            selectTicketPlusTickets(
                page,
                { ...settings, target: { ...settings.target, quantity: 0 } },
                identity,
                options,
            ),
            "before-click",
            "invalid-settings",
            0,
        );
        await rejectsQuantity(
            selectTicketPlusTickets(page, settings, identity, { ...options, timeoutMs: Infinity }),
            "before-click",
            "invalid-options",
            0,
        );
        assert.deepEqual((await quantityState(page)).clicks, noClicks);
    });
});

test("TicketPlus 張數：缺圖示、重複控制項與缺張數不當售完", { timeout: 15_000 }, async () => {
    for (const html of [
        quantityPage.replace("mdi-plus", "unknown-icon"),
        quantityPage.replace("</button>", '</button><button><i class="mdi-plus"></i></button>'),
        quantityPage.replace("<div>1</div>", "<div>?</div>"),
    ]) {
        await withPage(
            async page => {
                // 初始化會設張數，額外在讀取前製造缺資料。
                if (html.includes("<div>?</div>")) {
                    await page
                        .locator('[data-fixture="presale"] .count-button > div')
                        .evaluate(element => (element.textContent = "?"));
                }
                await rejectsQuantity(
                    selectTicketPlusTickets(page, settings, identity, options),
                    "before-click",
                    "unexpected-page",
                    0,
                );
                assert.deepEqual((await quantityState(page)).clicks, noClicks);
            },
            { html },
        );
    }
});

test("TicketPlus 張數：部分完成後整段期限仍生效，不因單次等待較長而延長", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsQuantity(
                selectTicketPlusTickets(page, settings, identity, {
                    ...options,
                    timeoutMs: 1_000,
                    changeTimeoutMs: 5_000,
                }),
                "after-click-attempt",
                "operation-timeout",
                2,
                1,
            );
            const state = await quantityState(page);
            assert.deepEqual(state.counts, { student: "0", presale: "1" });
            assert.deepEqual(state.clicks, { ...noClicks, presalePlus: 2 });
        },
        { behavior: "partial" },
    );
});

test("TicketPlus 張數：持續成功也受總期限限制，不能無限追逐巨大目標", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        const large = { ...settings, target: { ...settings.target, quantity: Number.MAX_SAFE_INTEGER } };
        await assert.rejects(
            selectTicketPlusTickets(page, large, identity, { ...options, timeoutMs: 1_000 }),
            error => {
                assert(error instanceof TicketPlusQuantityError);
                assert(["operation-timeout", "click-failed"].includes(error.reason));
                assert.equal(error.stage, "after-click-attempt");
                assert(error.attemptedClicks > 0 && error.attemptedClicks < Number.MAX_SAFE_INTEGER);
                return true;
            },
        );
        const state = await quantityState(page);
        assert(Number(state.counts.presale) > 0);
        assert.deepEqual(state.clicks, { ...noClicks, presalePlus: Number(state.counts.presale) });
    });
});

test("TicketPlus 張數：遮罩造成click逾時，記錄嘗試但不force或補按", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        await page
            .locator("body")
            .evaluate(body =>
                body.insertAdjacentHTML(
                    "beforeend",
                    '<div style="position:fixed;inset:0;z-index:99;background:white">遮罩</div>',
                ),
            );
        await rejectsQuantity(
            selectTicketPlusTickets(page, settings, identity, { ...options, clickTimeoutMs: 100 }),
            "after-click-attempt",
            "click-failed",
            1,
            0,
        );
        assert.deepEqual((await quantityState(page)).clicks, noClicks);
        assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "0" });
    });
});

test("TicketPlus 張數：庫存文案變更不改票名，新增同名列立即停止", { timeout: 15_000 }, async () => {
    for (const mode of ["stock", "duplicate", "reorder"] as const) {
        await withPage(async page => {
            // 初始快照讀完票種後，讀h1時排定DOM變動；之後必須使用新快照。
            await page.locator("body").evaluate(body => body.insertAdjacentHTML("beforeend", "<h1>fixture</h1>"));
            await page.evaluate(mode => {
                let changed = false;
                Object.defineProperty(document.querySelector("h1")!, "innerText", {
                    get() {
                        if (!changed) {
                            changed = true;
                            const row = document.querySelector('[data-fixture="presale"]')!;
                            if (mode === "duplicate") row.after(row.cloneNode(true));
                            if (mode === "reorder") row.parentElement!.prepend(row);
                            if (mode === "stock") row.querySelector(".v-chip__content")!.textContent = "剩餘 7";
                        }
                        return "fixture";
                    },
                });
            }, mode);
            if (mode === "duplicate") {
                await rejectsQuantity(
                    selectTicketPlusTickets(page, settings, identity, options),
                    "before-click",
                    "ticket-ambiguous",
                    0,
                    0,
                );
                assert.deepEqual((await quantityState(page)).clicks, noClicks);
            } else {
                await selectTicketPlusTickets(page, settings, identity, options);
                assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "2" });
                assert.deepEqual((await quantityState(page)).clicks, { ...noClicks, presalePlus: 2 });
            }
        });
    }
});
