import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { findTargetTickets } from "../src/platforms/ticketplus/ticketSelectionPage.js";
import * as fixture from "./fixtures/ticketplus/areaPage.js";
import { order, presale } from "./fixtures/ticketplus/pages.js";
import { selectTicketPlusTickets, TicketPlusQuantityError } from "../src/platforms/ticketplus/ticketQuantity.js";
import type { TicketPlusSelection } from "../src/config/platforms/ticketplus/activitySettings.js";

const orderUrl = "https://ticketplus.com.tw/order/0233a891800ffaa343bf8bff73d390e8/62ecd68cb52728a63ac9cff43172e04f";

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
        );
        await page.goto(orderUrl);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function read(page: Page, html: string) {
    await page.setContent(html);
    return readTicketPlusPage(page);
}

const areaB = (control: string, stock = fixture.selling) =>
    fixture.area({
        name: "B 區",
        stock,
        price: "7,000",
        state: "expanded",
        rows: [fixture.ticketRow("預售票", "7,000", control)],
    });

test("TicketPlus 票區：讀出所有票區與展開票區內的票種，收合票區沒有票種列", async () => {
    await withPage(async page => {
        const result = await read(page, fixture.areaOrder());
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(result.areas, [
            { name: "VIP 區", remainingQuantity: 0, expanded: false },
            { name: "A 區", remainingQuantity: 1, expanded: false },
            { name: "B 區", remainingQuantity: null, expanded: true },
            { name: "C 區", remainingQuantity: 20, expanded: false },
        ]);
        assert.deepEqual(result.tickets, [
            {
                area: "B 區",
                name: "預售票",
                selectedQuantity: 0,
                saleStatus: "selling",
                remainingQuantity: null,
                canIncrease: true,
                canDecrease: true,
            },
        ]);
    });
});

test("TicketPlus 票區：暫無票券與已售完（防禦案例）分開，剩餘 0 且無計數器", async () => {
    await withPage(async page => {
        for (const [text, status] of [
            [fixture.unavailableText, "unavailable"],
            [fixture.soldOutText, "sold-out"],
        ] as const) {
            const result = await read(page, fixture.areaOrder([areaB(text, fixture.remaining(0))]));
            assert.equal(result.kind, "ticket-selection");
            if (result.kind !== "ticket-selection") assert.fail();
            assert.equal(result.tickets[0]?.saleStatus, status);
            assert.equal(result.tickets[0]?.remainingQuantity, 0);
        }
    });
});

test("TicketPlus 票區：標題剩餘 0 有計數器時，0 張視為暫無票券，已選 1 張仍可購買", async () => {
    await withPage(async page => {
        const zero = await read(page, fixture.areaOrder([areaB(fixture.counter(0), fixture.remaining(0))]));
        assert.equal(zero.kind === "ticket-selection" && zero.tickets[0]?.saleStatus, "unavailable");
        const one = await read(page, fixture.areaOrder([areaB(fixture.counter(1), fixture.remaining(0))]));
        assert.equal(one.kind === "ticket-selection" && one.tickets[0]?.saleStatus, "selling");
        assert.equal(one.kind === "ticket-selection" && one.tickets[0]?.selectedQuantity, 1);
    });
});

test("TicketPlus 票區：目標比對用票區名稱，不用區內票種名稱", async () => {
    await withPage(async page => {
        const result = await read(page, fixture.areaOrder());
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(
            findTargetTickets(result.tickets, "B 區").map(ticket => ticket.name),
            ["預售票"],
        );
        assert.equal(findTargetTickets(result.tickets, "預售票").length, 0);
        assert.equal(findTargetTickets(result.tickets, "B區").length, 0);
    });
});

test("TicketPlus 票區：資料不完整或矛盾時不判讀", async () => {
    const twoRows = fixture.area({
        name: "B 區",
        stock: fixture.selling,
        price: "7,000",
        state: "expanded",
        rows: [
            fixture.ticketRow("全票", "7,000", fixture.counter(0)),
            fixture.ticketRow("學生票", "6,000", fixture.counter(0)),
        ],
    });
    const noStock = areaB(fixture.counter(0), "");
    const soldOutWithStock = areaB(fixture.soldOutText, fixture.remaining(3));
    const retainedSelected = fixture.area({
        name: "VIP 區",
        stock: fixture.remaining(5),
        price: "8,900",
        state: "retained",
        rows: [fixture.ticketRow("預售票", "8,900", fixture.counter(1))],
    });
    const cases: [string, string, string][] = [
        ["展開票區有兩種票", fixture.areaOrder([twoRows]), "ambiguous-data"],
        ["票區標題沒有庫存文字", fixture.areaOrder([noStock]), "incomplete-data"],
        ["已售完但標題剩餘不為 0", fixture.areaOrder([soldOutWithStock]), "incomplete-data"],
        ["收合票區的隱藏張數非零", fixture.areaOrder([retainedSelected, fixture.areaB]), "incomplete-data"],
        [
            "同名票區",
            fixture.areaOrder([
                fixture.areaB,
                fixture.area({ name: "B 區", stock: fixture.remaining(3), price: "7,000", state: "collapsed" }),
            ]),
            "ambiguous-data",
        ],
        ["票區與票種列混在同頁", fixture.areaOrder([fixture.areaB]) + presale, "incomplete-data"],
    ];
    await withPage(async page => {
        for (const [label, html, reason] of cases) {
            assert.deepEqual(await read(page, html), { kind: "unknown", reason }, label);
        }
    });
});

test("TicketPlus 票區：沒有價格的展開面板（例如說明）不算票區，票種列版型照常讀取", async () => {
    await withPage(async page => {
        const faq =
            '<div class="v-expansion-panel"><button type="button" class="v-expansion-panel-header">購票須知</button></div>';
        const result = await read(page, order + faq);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(result.areas, []);
        assert.deepEqual(
            result.tickets.map(ticket => [ticket.area, ticket.name]),
            [
                [null, "學生票"],
                [null, "預售票"],
                [null, "身障票"],
            ],
        );
    });
});

const selection: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "B 區", quantity: 1 },
};
const identity = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: selection.eventName,
    date: "2026-10-30",
    time: "20:00",
};

// 點擊用的票區頁：加減只改被點那一列的張數，並記錄點了哪一區。
async function withAreaClicks(html: string, run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
        await page.evaluate(() => {
            const clicks: string[] = [];
            (window as unknown as { areaClicks: string[] }).areaClicks = clicks;
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest(".count-button button");
                if (!button) return;
                const area = button.closest(".v-expansion-panel")!.querySelector("button")!.textContent!;
                const delta = button.querySelector(".mdi-plus") ? 1 : -1;
                clicks.push(`${area.includes("B 區") ? "B" : "other"}${delta > 0 ? "+" : "-"}`);
                const count = button.closest(".count-button")!.querySelector(":scope > div")!;
                count.textContent = String(Number(count.textContent) + delta);
            });
        });
        await run(page);
    } finally {
        await browser.close();
    }
}

const clicks = (page: Page) => page.evaluate(() => (window as unknown as { areaClicks: string[] }).areaClicks);

test("TicketPlus 票區：以票區名稱加票，點在該票區的計數器", async () => {
    await withAreaClicks(fixture.areaOrder(), async page => {
        const result = await selectTicketPlusTickets(page, selection, identity, { timeoutMs: 5_000 });
        assert.equal(findTargetTickets(result.tickets, "B 區")[0]?.selectedQuantity, 1);
        assert.deepEqual(await clicks(page), ["B+"]);
    });
});

test("TicketPlus 票區：用區內票種名稱當目標找不到，零點擊", async () => {
    await withAreaClicks(fixture.areaOrder(), async page => {
        const target = { ...selection, target: { ...selection.target, ticketType: "預售票" } };
        await assert.rejects(
            selectTicketPlusTickets(page, target, identity, { timeoutMs: 5_000 }),
            (error: unknown) => {
                assert(error instanceof TicketPlusQuantityError);
                assert.equal(error.reason, "ticket-missing");
                return true;
            },
        );
        assert.deepEqual(await clicks(page), []);
    });
});

test("TicketPlus 票區：標題剩餘 0、0 張（暫無票券）時不點加號", async () => {
    const held = fixture.areaOrder([areaB(fixture.counter(0), fixture.remaining(0))]);
    await withAreaClicks(held, async page => {
        await assert.rejects(
            selectTicketPlusTickets(page, selection, identity, { timeoutMs: 5_000 }),
            (error: unknown) => {
                assert(error instanceof TicketPlusQuantityError);
                assert.equal(error.reason, "ticket-unavailable");
                assert.equal(error.attemptedClicks, 0);
                return true;
            },
        );
        assert.deepEqual(await clicks(page), []);
    });
});

test("TicketPlus 票區：抽選選票頁（全區 NT.0、區內票種「登記抽選」）可讀出目標票區", async () => {
    await withPage(async page => {
        // 依 2026-10-17 抽選實站：票區面板、熱賣中、NT.0，展開後唯一票種為「登記抽選」
        const lotteryArea = (name: string, expanded: boolean) =>
            fixture.area({
                name,
                stock: fixture.selling,
                price: "0",
                state: expanded ? "expanded" : "collapsed",
                rows: [fixture.ticketRow("登記抽選", "0", fixture.counter())],
            });
        const result = await read(
            page,
            fixture.areaOrder([lotteryArea("全區（不含身障區）", false), lotteryArea("3880區~800區皆可", true)]),
        );
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(
            result.areas.map(area => [area.name, area.expanded]),
            [
                ["全區（不含身障區）", false],
                ["3880區~800區皆可", true],
            ],
        );
        assert.deepEqual(
            result.tickets.map(ticket => [ticket.area, ticket.name, ticket.saleStatus, ticket.selectedQuantity]),
            [["3880區~800區皆可", "登記抽選", "selling", 0]],
        );
    });
});
