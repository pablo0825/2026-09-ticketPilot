import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { readTicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";
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
                {
                    name: event.eventName,
                    date: "2026-10-30",
                    time: "20:00",
                    buyEnabled: true,
                    saleState: "available",
                    buttonText: "立即購買",
                },
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
            areas: [],
            tickets: [
                {
                    area: null,
                    name: "學生票",
                    selectedQuantity: 0,
                    saleStatus: "selling",
                    remainingQuantity: 14,
                    canIncrease: true,
                    canDecrease: false,
                },
                {
                    area: null,
                    name: "預售票",
                    selectedQuantity: 1,
                    saleStatus: "selling",
                    remainingQuantity: null,
                    canIncrease: true,
                    canDecrease: true,
                },
                {
                    area: null,
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

test("TicketPlus 選票：以價格找票種列，列的 class 改變仍讀出相同票種", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order);
        const expected = await readTicketPlusPage(page);
        assert.equal(expected.kind, "ticket-selection");

        // 列 class 換掉後，價格仍能把每一列找出來。
        await page.setContent(fixture.order.replaceAll("row py-1 py-md-4 rwd-margin no-gutters", "ticket-line"));
        assert.deepEqual(await readTicketPlusPage(page), expected);
    });
});

test("TicketPlus 選票：只有一列時，列不會往外擴到包含標題或按鈕的容器", async () => {
    await withPage(async page => {
        const row = fixture.student.replace("row py-1 py-md-4 rwd-margin no-gutters", "ticket-line");
        await show(
            page,
            orderUrl,
            `<div class="page">${fixture.eventHeader}<div class="card"><div class="list">${row}</div></div><button>下一步</button></div>`,
        );
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(
            result.tickets.map(ticket => [ticket.name, ticket.remainingQuantity]),
            [["學生票", 14]],
        );
    });
});

test("TicketPlus 選票：價格格式不同而找不到列時，以資料不完整停止，不默默少一列", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order.replace("NT. 450", "NT. <b>450</b>"));
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "incomplete-data" });
    });
});

test("TicketPlus 選票：只有一列且只剩名稱與價格（更新空窗）時，列仍停在票種列", async () => {
    await withPage(async page => {
        const row = fixture.student
            .replace("<span>剩餘 14</span>", "")
            .replace(/<div class="count-button[\s\S]*?<\/div><\/div>/, "</div>");
        await show(
            page,
            orderUrl,
            `<div class="page">${fixture.eventHeader}<div class="card"><div class="list">${row}</div></div><button>下一步</button></div>`,
        );
        const dom = await readTicketPlusDom(page);
        assert.deepEqual(
            dom.tickets.map(ticket => [ticket.names, ticket.counterCount]),
            [[["學生票"], 0]],
        );
    });
});

test("TicketPlus 選票：票種列的暫無票券（防禦案例，實站未觀察）是 unavailable，不是售完", async () => {
    await withPage(async page => {
        await show(page, orderUrl, fixture.order.replace("已售完", "暫無票券"));
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "ticket-selection");
        if (result.kind !== "ticket-selection") assert.fail();
        assert.deepEqual(
            result.tickets.map(ticket => [ticket.name, ticket.saleStatus]),
            [
                ["學生票", "selling"],
                ["預售票", "selling"],
                ["身障票", "unavailable"],
            ],
        );
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

test("TicketPlus 資料頁含摘要：仍核對必要元素與真正付款標記", async () => {
    await withPage(async page => {
        await show(page, confirmUrl, fixture.information + fixture.summary);
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "information");
        if (result.kind !== "information") assert.fail();
        assert.equal(result.sessionId, sessionId);
        assert.equal(result.termsChecked, false);
        assert.equal(result.nextEnabled, false);
        assert.doesNotMatch(JSON.stringify(result), /fixture@example.invalid|0900000000|測試姓名/);

        // 摘要不取代資料頁驗證，也不能掩蓋付款操作或殘留選票內容。
        const cases = [
            [fixture.summary, "incomplete-data"],
            [fixture.information + fixture.summary + "<button disabled>前往付款</button>", "conflicting-page"],
            [
                fixture.information + fixture.summary + '<div class="stepText checkedStep">付款結帳</div>',
                "conflicting-page",
            ],
            [fixture.information + fixture.summary + '<div role="dialog">未知提示</div>', "blocking-dialog"],
            [fixture.information + fixture.summary + fixture.queue, "conflicting-page"],
            [fixture.information + fixture.summary + fixture.presale, "conflicting-page"],
            [fixture.information + fixture.summary + "<button>下一步</button>", "ambiguous-data"],
            [fixture.information.replace("聯絡人資訊", "其他標題") + fixture.summary, "incomplete-data"],
        ];
        for (const [html, reason] of cases) {
            await page.setContent(html!);
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason });
        }

        // 活動與選票路徑的摘要衝突維持原規則，付款頁仍正常辨識。
        await show(page, activityUrl, fixture.activity + fixture.summary);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
        await show(page, orderUrl, fixture.order + fixture.summary);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
        await show(page, checkoutUrl, fixture.checkout);
        assert.equal((await readTicketPlusPage(page)).kind, "checkout");
    });
});

test("TicketPlus 路徑診斷：只輸出類型，不輸出路徑或參數", async () => {
    await withPage(async page => {
        for (const [url, kind] of [
            [activityUrl, "activity"],
            [orderUrl, "order"],
            [confirmUrl, "confirm"],
            [checkoutUrl, "checkout"],
            [origin + "/PRIVATE_PATH", "other"],
            [confirmUrl + "?token=PRIVATE_TOKEN", "confirm"],
        ]) {
            await show(page, url!, fixture.information + fixture.summary);
            let diagnostic: unknown;
            await readTicketPlusPage(page, value => {
                diagnostic = value;
            });
            assert.equal((diagnostic as { routeKind: string }).routeKind, kind);
            assert.doesNotMatch(
                JSON.stringify(diagnostic),
                /PRIVATE_|0233a891|62ecd68c|fixture@example.invalid|0900000000/,
            );
        }
    });
});

test("TicketPlus 活動欄位診斷：同快照描述缺少、空白、歧義與格式，不改分類", async () => {
    await withPage(async page => {
        const row = (content: string) => `<div class="sesstion-item">${content}</div>`;
        const name = '<div class="font-weight-bold is-word-break">PRIVATE_SESSION</div>';
        const dateField = (value: string) =>
            `<div class="d-flex"><div class="wordBreakKeepAll">日期</div><div>${value}</div></div>`;
        const timeField = (value: string) =>
            `<div class="d-flex"><div class="wordBreakKeepAll">時間</div><div>${value}</div></div>`;
        const date = dateField("2026-10-30(五)");
        const time = timeField("20:00");
        const button = "<button>立即購買</button>";
        const valid = {
            names: 1,
            nameNonEmpty: true,
            dateField: { labels: 1, values: 1 },
            timeField: { labels: 1, values: 1 },
            dates: 1,
            dateValid: true,
            times: 1,
            timeValid: true,
            buttons: 1,
            knownButtonText: true,
            buttonEnabled: true,
        };
        const cases = [
            { body: row(name + date + time + button), expected: valid },
            { body: row(date + time + button), expected: { ...valid, names: 0, nameNonEmpty: false } },
            {
                body: row(name.replace("PRIVATE_SESSION", "") + date + time + button),
                expected: { ...valid, nameNonEmpty: false },
            },
            {
                body: row(name + time + button),
                expected: { ...valid, dateField: { labels: 0, values: 0 }, dates: 0, dateValid: false },
            },
            { body: row(name + dateField("2026-02-30") + time + button), expected: { ...valid, dateValid: false } },
            {
                body: row(name + dateField("2026/10/30") + time + button),
                expected: { ...valid, dates: 0, dateValid: false },
            },
            {
                body: row(name + date + button),
                expected: { ...valid, timeField: { labels: 0, values: 0 }, times: 0, timeValid: false },
            },
            { body: row(name + date + timeField("25:61") + button), expected: { ...valid, timeValid: false } },
            {
                body: row(name + date + time),
                expected: { ...valid, buttons: 0, knownButtonText: false, buttonEnabled: null },
            },
            {
                body: row(name + date + time + "<button>PRIVATE_BUTTON</button>"),
                expected: { ...valid, knownButtonText: false },
            },
            {
                body: row(name + date + time + "<button disabled>尚未開賣</button>"),
                expected: { ...valid, buttonEnabled: false },
            },
            {
                body: row(name + name + date + date + time + time + button + button),
                expected: {
                    names: 2,
                    nameNonEmpty: false,
                    dateField: { labels: 2, values: 2 },
                    timeField: { labels: 2, values: 2 },
                    dates: 2,
                    dateValid: false,
                    times: 2,
                    timeValid: false,
                    buttons: 2,
                    knownButtonText: false,
                    buttonEnabled: null,
                },
            },
        ];
        for (const item of cases) {
            await show(page, activityUrl, `<h1>${event.eventName}</h1>${item.body}`);
            const baseline = await readTicketPlusPage(page);
            let fields;
            const observed = await readTicketPlusPage(
                page,
                diagnostic => {
                    fields = diagnostic.activityFields;
                },
                event.eventName,
            );
            assert.deepEqual(observed, baseline);
            assert.deepEqual(fields, {
                headings: { count: 1, nonEmptyCount: 1, matchingCount: 1 },
                rows: [item.expected],
            });
            assert.doesNotMatch(JSON.stringify(fields), /PRIVATE|孿生|https:|2026|20:00/);
        }
        for (const [html, expected] of [
            ["", { count: 0, nonEmptyCount: 0, matchingCount: 0 }],
            ['<h1 style="min-height:20px"></h1>', { count: 1, nonEmptyCount: 0, matchingCount: 0 }],
            ["<h1>PRIVATE_HEADING</h1>", { count: 1, nonEmptyCount: 1, matchingCount: 0 }],
            [
                `<h1>${event.eventName}</h1><h1>${event.eventName}</h1>`,
                { count: 2, nonEmptyCount: 2, matchingCount: 2 },
            ],
        ] as const) {
            await show(page, activityUrl, html);
            let fields;
            await readTicketPlusPage(
                page,
                diagnostic => {
                    fields = diagnostic.activityFields;
                },
                event.eventName,
            );
            assert.deepEqual(fields, { headings: expected, rows: [] });
        }
    });
});

test("TicketPlus 活動：抽選的「立即登記」視為可進入，並保留按鈕文字", async () => {
    await withPage(async page => {
        await show(page, activityUrl, fixture.activity.replace("<span>立即購買</span>", "<span>立即登記</span>"));
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "activity");
        if (result.kind !== "activity") assert.fail();
        assert.deepEqual(
            result.sessions.map(row => [row.saleState, row.buyEnabled, row.buttonText]),
            [["available", true, "立即登記"]],
        );

        // 診斷也視為已知按鈕
        const dom = await readTicketPlusDom(page);
        const { diagnoseActivityFields } = await import("../src/platforms/ticketplus/activityPage.js");
        assert.equal(diagnoseActivityFields(dom, event.eventName).rows[0]!.knownButtonText, true);
    });
});

test("TicketPlus 排隊：抽選「排隊登記中 請稍候」在頁面或彈窗內都算排隊", async () => {
    await withPage(async page => {
        // 頁面 h3 形式，附加第二句仍為排隊
        await show(page, orderUrl, fixture.order + fixture.lotteryQueue);
        assert.deepEqual(await readTicketPlusPage(page), { kind: "queue", eventId, sessionId });

        // 彈窗形式不能被當成未知彈窗
        await show(
            page,
            orderUrl,
            fixture.order +
                `<div class="v-dialog__content"><div class="v-dialog" role="dialog">${fixture.lotteryQueue}</div></div>`,
        );
        assert.deepEqual(await readTicketPlusPage(page), { kind: "queue", eventId, sessionId });

        // 第二句在 h3 內時仍為排隊
        await show(page, orderUrl, fixture.order + "<h3>排隊登記中<br>請稍候<br>若人數眾多可能需要較長等待時間</h3>");
        assert.deepEqual(await readTicketPlusPage(page), { kind: "queue", eventId, sessionId });

        // 文字不同時不算排隊
        await show(page, orderUrl, fixture.order + "<h3>排隊登記中 請稍後再試</h3>");
        assert.notEqual((await readTicketPlusPage(page)).kind, "queue");
    });
});
