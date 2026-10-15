import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import * as fixture from "./fixtures/ticketplus/pages.js";

const origin = "https://ticketplus.com.tw";
const eventId = "0233a891800ffaa343bf8bff73d390e8";
const sessionId = "62ecd68cb52728a63ac9cff43172e04f";
const activityUrl = `${origin}/activity/${eventId}`;
const orderUrl = `${origin}/order/${eventId}/${sessionId}`;
const confirmUrl = `${origin}/confirm/${eventId}/${sessionId}`;
const checkoutUrl = `${origin}/checkout/${eventId}/${sessionId}`;

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
        );
        await run(page);
    } finally {
        await browser.close();
    }
}

async function show(page: Page, url: string, html: string): Promise<void> {
    await page.goto(url);
    await page.setContent(html);
}

const event = { eventId, sessionId, eventName: "2026孿生姐妹之夜之鬼迷心竅", date: "2026-10-30", time: "20:00" };

test("TicketPlus 活動：忽略隱藏標題、區分 tab/button，保存各列場次與按鈕", async () => {
    await withPage(async page => {
        await show(page, activityUrl, fixture.activity);
        assert.deepEqual(await readTicketPlusPage(page), {
            kind: "activity",
            eventId,
            eventName: event.eventName,
            sessions: [
                { name: event.eventName, date: "2026-10-30", time: "20:00", buyEnabled: true, saleState: "available" },
            ],
        });
        // 人工防禦案例：第二場次不得取用第一列按鈕或日期。
        await page.setContent(
            fixture.activity +
                fixture.session.replace("20:00", "21:00").replace('type="button"', 'type="button" disabled'),
        );
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "activity");
        if (result.kind !== "activity") assert.fail();
        assert.deepEqual(
            result.sessions.map(row => [row.time, row.buyEnabled]),
            [
                ["20:00", true],
                ["21:00", false],
            ],
        );
    });
});

test("TicketPlus 選票：讀出所有票種、真實張數與售票文案，不以價格或庫存當張數", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order);
        assert.deepEqual(await readTicketPlusPage(page), {
            kind: "ticket-selection",
            ...event,
            nextEnabled: true,
            tickets: [
                {
                    name: "學生票",
                    selectedQuantity: 0,
                    saleStatus: "selling",
                    remainingQuantity: 14,
                    canIncrease: true,
                    canDecrease: false,
                },
                {
                    name: "預售票",
                    selectedQuantity: 1,
                    saleStatus: "selling",
                    remainingQuantity: null,
                    canIncrease: true,
                    canDecrease: true,
                },
                {
                    name: "身障票",
                    selectedQuantity: 0,
                    saleStatus: "sold-out",
                    remainingQuantity: 0,
                    canIncrease: false,
                    canDecrease: false,
                },
            ],
        });
        await page.setContent(
            fixture.order +
                `<div hidden>${fixture.presale}</div>` +
                fixture.presale.replace("預售票", "預售票－優惠票"),
        );
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(
            result.tickets.map(ticket => ticket.name),
            ["學生票", "預售票", "身障票", "預售票－優惠票"],
        );
    });
});

test("TicketPlus 排隊：只在 order 優先，隱藏提示不算，消失不代表成功", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order + fixture.queue);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "queue", eventId, sessionId });
        await page.setContent(fixture.order + `<div hidden>${fixture.queue}</div>`);
        assert.equal((await readTicketPlusPage(page)).kind, "ticket-selection");
        await page.setContent(fixture.queue + fixture.queue);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "ambiguous-data" });
        await page.setContent("");
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "incomplete-data" });
        await show(page, checkoutUrl, fixture.checkout + fixture.queue);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
    });
});

test("TicketPlus 網址與 DOM：拒絕錯站、額外路徑、缺 ID、未知 query 和跨頁矛盾", async () => {
    await withPage(async page => {
        for (const url of [
            orderUrl.replace(origin, "https://example.test"),
            orderUrl.replace("https:", "http:"),
            `${origin}/order/${eventId}`,
            orderUrl + "/extra",
            orderUrl + "?token=fixture",
            orderUrl + "#unknown",
        ]) {
            await show(page, url, fixture.order);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "unsupported-url" });
        }
        for (const [url, html] of [
            [confirmUrl, fixture.order],
            [orderUrl, fixture.information],
            [activityUrl, fixture.checkout],
        ]) {
            await show(page, url!, html!);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
        }
        await show(page, orderUrl.replace(sessionId, "different-session"), fixture.order);
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.equal(result.sessionId, "different-session");
    });
});

test("TicketPlus 選票資料缺漏與矛盾不可當成零張或售完", async () => {
    const badRows = [
        fixture.presale.replace("<div>1</div>", "<div>?</div>"),
        fixture.presale.replace("<div>1</div>", "<div>-1</div>"),
        fixture.presale.replace("<div>1</div>", "<div>9007199254740992</div>"),
        fixture.presale.replace("<div>1</div>", ""),
        fixture.presale.replace('class="mdi mdi-plus"', 'class="unknown-icon"'),
        fixture.presale.replace("熱賣中", "未知狀態"),
        fixture.presale.replace("熱賣中", "剩餘 0"),
        fixture.soldOut.replace("已售完", ""),
        fixture.soldOut.replace("剩餘 0", "剩餘 10"),
        fixture.presale.replace("</button>", '</button><button><i class="mdi mdi-plus"></i></button>'),
    ];
    await withPage(async page => {
        for (const row of badRows) {
            await show(page, orderUrl, `${fixture.eventHeader}${row}<button>下一步</button>`);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "incomplete-data" });
        }
        await page.setContent(fixture.order.replace("2026-10-30", "2026-02-30"));
        assert.equal((await readTicketPlusPage(page)).kind, "unknown");
    });
});

test("TicketPlus 加號停用不代表售完，同名列不合併", async () => {
    await withPage(async page => {
        await show(
            page,
            orderUrl,
            fixture.order.replace(
                /<button type="button"><span><i aria-hidden="true" class="mdi mdi-plus"/g,
                '<button type="button" disabled><span><i aria-hidden="true" class="mdi mdi-plus"',
            ) + fixture.presale,
        );
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.equal(result.tickets[1]?.saleStatus, "selling");
        assert.equal(result.tickets[1]?.canIncrease, false);
        assert.equal(result.tickets.filter(ticket => ticket.name === "預售票").length, 2);
    });
});

test("TicketPlus 資料頁：條款前後、缺欄位狀態，不輸出個資", async () => {
    await withPage(async page => {
        await show(page, confirmUrl, fixture.information);
        assert.deepEqual(await readTicketPlusPage(page), {
            kind: "information",
            eventId,
            sessionId,
            contactFields: {
                name: { present: true, hasValue: true, disabled: true },
                phone: { present: true, hasValue: true, disabled: true },
                email: { present: true, hasValue: true, disabled: true },
            },
            termsChecked: false,
            nextEnabled: false,
        });
        await page.setContent(
            fixture.information
                .replace('type="checkbox">我', 'type="checkbox" checked>我')
                .replace('type="button" disabled', 'type="button"'),
        );
        const checked = await readTicketPlusPage(page);
        assert.equal(checked.kind, "information");
        if (checked.kind !== "information") assert.fail();
        assert.equal(checked.termsChecked, true);
        assert.equal(checked.nextEnabled, true);
        assert(!JSON.stringify(checked).includes("fixture@example.invalid"));
        assert(!JSON.stringify(checked).includes("0900000000"));
        assert(!JSON.stringify(checked).includes("測試姓名"));

        await page.locator("#fixture-phone").evaluate(element => element.remove());
        const missing = await readTicketPlusPage(page);
        assert.equal(missing.kind, "information");
        if (missing.kind !== "information") assert.fail();
        assert.deepEqual(missing.contactFields.phone, { present: false, hasValue: false, disabled: false });
        await page.setContent(fixture.information + fixture.information);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "ambiguous-data" });
    });
});

test("TicketPlus 付款摘要：保留所有票種，缺必要欄位或只剩付款按鈕不是完整付款頁", async () => {
    await withPage(async page => {
        await show(page, checkoutUrl, fixture.checkout + fixture.summary.replace("預售票", "學生票"));
        assert.deepEqual(await readTicketPlusPage(page), {
            kind: "checkout",
            ...event,
            tickets: [
                { name: "預售票", quantity: 1 },
                { name: "學生票", quantity: 1 },
            ],
            paymentEnabled: true,
        });
        for (const html of [
            fixture.checkout.replace("<div>1</div>", "<div></div>"),
            fixture.checkout.replace("2026-10-30", ""),
            fixture.checkout.replace(fixture.summary, ""),
            "<button>前往付款</button>",
        ]) {
            await page.setContent(html);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "incomplete-data" });
        }
    });
});

test("TicketPlus 唯讀入口：不點擊、送出、輸入、勾選或導頁", async () => {
    await withPage(async page => {
        for (const [url, html] of [
            [activityUrl, fixture.activity],
            [orderUrl, fixture.order],
            [orderUrl, fixture.queue],
            [confirmUrl, fixture.information],
            [checkoutUrl, fixture.checkout],
        ]) {
            await show(page, url!, `<form>${html}</form>`);
            await page.evaluate(() => {
                document.body.dataset.actions = "0";
                for (const type of ["click", "submit", "input", "change"]) {
                    document.addEventListener(
                        type,
                        event => {
                            event.preventDefault();
                            document.body.dataset.actions = String(Number(document.body.dataset.actions) + 1);
                        },
                        true,
                    );
                }
            });
            const before = await page.locator("input").evaluateAll(elements =>
                elements.map(element => ({
                    value: (element as HTMLInputElement).value,
                    checked: (element as HTMLInputElement).checked,
                })),
            );
            const result = await readTicketPlusPage(page);
            assert.notEqual(result.kind, "unknown");
            assert.equal(await page.locator("body").getAttribute("data-actions"), "0");
            assert.equal(page.url(), url);
            assert.deepEqual(
                await page.locator("input").evaluateAll(elements =>
                    elements.map(element => ({
                        value: (element as HTMLInputElement).value,
                        checked: (element as HTMLInputElement).checked,
                    })),
                ),
                before,
            );
        }
    });
});

test("TicketPlus 關閉頁面不洩漏原始錯誤，未知狀態不含個資", async () => {
    await withPage(async page => {
        await show(page, confirmUrl, fixture.information);
        await page.close();
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "read-failed" });
    });
});

test("TicketPlus 讀取期間網址變動時拒絕混合快照，再次讀取採新頁面", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order);
        // 人工控制變動時點：reader 讀標題時改路徑，無 sleep 或 reader mock。
        await page.evaluate(pathname => {
            const heading = document.querySelector<HTMLElement>(".text-page-title")!;
            const original = heading.innerText;
            Object.defineProperty(heading, "innerText", {
                get() {
                    history.replaceState(null, "", pathname);
                    return original;
                },
            });
        }, `/confirm/${eventId}/${sessionId}`);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "page-changed" });
        await page.setContent(fixture.information);
        assert.equal((await readTicketPlusPage(page)).kind, "information");
    });
});

test("TicketPlus 唯一欄位重複、隱藏父容器與不合法場次皆保守拒絕", async () => {
    await withPage(async page => {
        for (const html of [
            fixture.activity + `<h1>${event.eventName}</h1>`,
            fixture.activity.replace("<span>立即購買</span>", "<span>立即購買</span></button><button>立即購買"),
        ]) {
            await show(page, activityUrl, html);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "ambiguous-data" });
        }
        await page.setContent(fixture.activity.replace("20:00", "25:00"));
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "incomplete-data" });
        await show(page, orderUrl, fixture.order + fixture.eventHeader);
        assert.equal((await readTicketPlusPage(page)).kind, "unknown");
        await page.setContent(fixture.order + `<div style="display:none">${fixture.order}</div>`);
        assert.equal((await readTicketPlusPage(page)).kind, "ticket-selection");
    });
});

test("TicketPlus 活動：尚未開賣即使 enabled 也不標為可買，停用立即購買另分類", async () => {
    await withPage(async page => {
        const notOnSale = fixture.session.replace("立即購買", "尚未開賣");
        await show(page, activityUrl, fixture.activity + notOnSale.replace("20:00", "21:00"));
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "activity");
        if (result.kind !== "activity") assert.fail();
        assert.deepEqual(
            result.sessions.map(row => [row.time, row.saleState, row.buyEnabled]),
            [
                ["20:00", "available", true],
                ["21:00", "not-on-sale", false],
            ],
        );
        await page.setContent(fixture.activity.replace('type="button"', 'type="button" disabled'));
        const disabled = await readTicketPlusPage(page);
        assert.equal(disabled.kind, "activity");
        if (disabled.kind !== "activity") assert.fail();
        assert.equal(disabled.sessions[0]?.saleState, "disabled");
    });
});

test("TicketPlus 活動：未知、缺少、重複與矛盾的場次按鈕不推論尚未開賣", async () => {
    await withPage(async page => {
        const cases = [
            [fixture.activity.replace("<span>立即購買</span>", "<span>已售完</span>"), "incomplete-data"],
            [fixture.activity.replace(/<button[^>]*>[\s\S]*?<\/button>/, ""), "incomplete-data"],
            [fixture.activity.replace("</button>", "</button><button>尚未開賣</button>"), "ambiguous-data"],
            [fixture.activity.replace("</button>", "</button><button>立即購買</button>"), "ambiguous-data"],
            [fixture.activity.replace("</button>", "</button><button>未知操作</button>"), "ambiguous-data"],
        ];
        for (const [html, reason] of cases) {
            await show(page, activityUrl, html!);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason });
        }
        await show(
            page,
            activityUrl,
            fixture.activity.replace("</button>", "</button><button hidden>尚未開賣</button>"),
        );
        assert.equal((await readTicketPlusPage(page)).kind, "activity");
    });
});
