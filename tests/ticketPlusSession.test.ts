import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import { selectTicketPlusSession, TicketPlusSessionError } from "../src/platforms/ticketplus/sessionSelection.js";
import type { SessionEntryStage, SessionEntryReason } from "../src/platforms/ticketplus/sessionSelection.js";
import * as fixture from "./fixtures/ticketplus/pages.js";
import { delayedNotice, noticeBehavior, noticeDialog, noticeTitles } from "./fixtures/ticketplus/activityNotice.js";

const origin = "https://ticketplus.com.tw";
const activityUrl = `${origin}/activity/event-fixture`;
const eventName = "2026孿生姐妹之夜之鬼迷心竅";
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: activityUrl,
    eventName,
    target: { date: "2026-10-30", time: "21:00", ticketType: "預售票", quantity: 2 },
};
const options = { clickTimeoutMs: 3_000, arrivalTimeoutMs: 5_000, pollIntervalMs: 20 };

// 每列目的地固定，與傳給正式程式的 settings 無關。data-fixture 僅供測試事件辨識。
const rowA = fixture.session.replace('class="sesstion-item"', 'class="sesstion-item" data-fixture="A"');
const rowB = fixture.session
    .replace("20:00", "21:00")
    .replace(eventName, "晚場 [B] (特別)")
    .replace('class="sesstion-item"', 'class="sesstion-item" data-fixture="B"');
const heading = `<h1>${eventName}</h1><div role="tab">立即購買</div>`;
const activity = heading + rowA + rowB;

// 入場後尚未選票：所有票種 0 張。不是已有 1 張的 reader 觀察樣本。
const emptyOrder = fixture.order
    .replace("<div>1</div>", "<div>0</div>")
    .replace(
        /<button type="button"><span><i aria-hidden="true" class="mdi mdi-minus"/g,
        '<button type="button" disabled><span><i aria-hidden="true" class="mdi mdi-minus"',
    )
    .replace('<button type="button">下一步</button>', '<button type="button" disabled>下一步</button>');
const orderA = emptyOrder;
const orderB = emptyOrder.replace("20:00", "21:00");

interface FixtureOptions {
    html?: string;
    destinationB?: string;
    orderB?: string;
    noNavigation?: boolean;
    beforeOrder?: () => Promise<void>;
}

async function withPage(run: (page: Page) => Promise<void>, fixtureOptions: FixtureOptions = {}): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        // 實際 DOM click 事件才計數；選票頁的任何 click 另計，不依賴正式程式的回傳值。
        await page.addInitScript(
            ({ destination, noNavigation }) => {
                document.addEventListener(
                    "click",
                    event => {
                        const element = event.target as Element;
                        const row = element.closest(".sesstion-item");
                        const key =
                            row?.getAttribute("data-fixture") ?? (element.closest('[role="tab"]') ? "tab" : "other");
                        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
                        if (!row || !element.closest("button") || noNavigation) return;
                        location.href = key === "A" ? "/order/event-fixture/session-A" : destination;
                    },
                    true,
                );
            },
            {
                destination: fixtureOptions.destinationB ?? "/order/event-fixture/session-B",
                noNavigation: fixtureOptions.noNavigation ?? false,
            },
        );
        await page.route("**/*", async route => {
            const pathname = new URL(route.request().url()).pathname;
            let html = fixtureOptions.html ?? activity;
            if (pathname !== "/activity/event-fixture") {
                if (fixtureOptions.beforeOrder) await fixtureOptions.beforeOrder();
                html = pathname.endsWith("session-A") ? orderA : (fixtureOptions.orderB ?? orderB);
            }
            await route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
        });
        await page.goto(activityUrl);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function counts(page: Page): Promise<Record<string, number>> {
    return page.evaluate(() =>
        Object.fromEntries(["A", "B", "tab", "other"].map(key => [key, Number(sessionStorage.getItem(key) ?? "0")])),
    );
}

async function rejectsEntry(
    promise: Promise<unknown>,
    stage: SessionEntryStage,
    reason?: SessionEntryReason,
): Promise<void> {
    await assert.rejects(promise, error => {
        assert(error instanceof TicketPlusSessionError);
        assert.equal(error.stage, stage);
        if (reason) assert.equal(error.reason, reason);
        return true;
    });
}

test("TicketPlus 場次：選第二列，固定目的地驗證日期時間，只按目標一次", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        const result = await selectTicketPlusSession(page, settings, options);
        assert.equal(result.kind, "ticket-selection");
        assert.equal(result.eventId, "event-fixture");
        assert.equal(result.sessionId, "session-B");
        assert.equal(result.eventName, eventName);
        assert.equal(result.date, "2026-10-30");
        assert.equal(result.time, "21:00");
        assert.deepEqual(
            result.tickets.map(ticket => ticket.selectedQuantity),
            [0, 0, 0],
        );
        assert.equal(result.nextEnabled, false);
        assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
    });
});

test("TicketPlus 場次：列重排與隱藏副本仍選 B，不依舊索引", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            const result = await selectTicketPlusSession(page, settings, options);
            assert.equal(result.sessionId, "session-B");
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { html: heading + rowB + rowA + `<div hidden>${rowB}</div>` },
    );
});

test("TicketPlus 場次：活動不符、無目標、停用與重複列皆零點擊", { timeout: 15_000 }, async () => {
    const cases: { html: string; reason: SessionEntryReason }[] = [
        { html: activity.replace(`<h1>${eventName}</h1>`, "<h1>另一活動</h1>"), reason: "activity-mismatch" },
        { html: heading + rowA, reason: "session-missing" },
        { html: heading + rowB.replace('type="button"', 'type="button" disabled'), reason: "session-disabled" },
        { html: activity + rowB, reason: "session-ambiguous" },
        { html: activity + rowB.replace('type="button"', 'type="button" disabled'), reason: "session-ambiguous" },
    ];
    for (const item of cases) {
        await withPage(async page => {
            await rejectsEntry(selectTicketPlusSession(page, settings, options), "before-click", item.reason);
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        }, item);
    }
});

test("TicketPlus 場次：錯活動 ID、不合法設定或等待參數都在操作前拒絕", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        await rejectsEntry(
            selectTicketPlusSession(page, { ...settings, eventUrl: `${origin}/activity/another` }, options),
            "before-click",
            "activity-mismatch",
        );
        await rejectsEntry(
            selectTicketPlusSession(page, { ...settings, target: { ...settings.target, date: "2026-02-30" } }, options),
            "before-click",
            "invalid-settings",
        );
        for (const value of [0, -1, NaN, Infinity, 2_147_483_648]) {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: value }),
                "before-click",
                "invalid-options",
            );
        }
        assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
    });
});

test("TicketPlus 場次：點擊後不跳頁，期限內停止且不重點", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 100 }),
                "after-click-attempt",
                "arrival-timeout",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            assert.equal(page.url(), activityUrl);
        },
        { noNavigation: true },
    );
});

test("TicketPlus 場次：目的地錯活動、名稱、日期、時間都不回成功", { timeout: 15_000 }, async () => {
    const cases = [
        { destinationB: "/order/another/session-B", reason: "unexpected-page" as const },
        { orderB: orderB.replace(eventName, "另一活動"), reason: "arrival-mismatch" as const },
        { orderB: orderB.replace("2026-10-30", "2026-10-31"), reason: "arrival-mismatch" as const },
        { orderB: orderA, reason: "arrival-mismatch" as const },
    ];
    for (const item of cases) {
        await withPage(async page => {
            await rejectsEntry(selectTicketPlusSession(page, settings, options), "after-click-attempt", item.reason);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        }, item);
    }
});

test("TicketPlus 場次：未知頁、排隊、資料與付款頁均不自動接續", { timeout: 15_000 }, async () => {
    const cases = [
        { orderB: fixture.queue },
        { destinationB: "/confirm/event-fixture/session-B", orderB: fixture.information },
        { destinationB: "/checkout/event-fixture/session-B", orderB: fixture.checkout },
    ];
    for (const item of cases) {
        await withPage(async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, options),
                "after-click-attempt",
                "unexpected-page",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        }, item);
    }
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 100 }),
                "after-click-attempt",
                "arrival-timeout",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: "<main>載入中</main>" },
    );
});

test("TicketPlus 場次：受控延遲導頁，只點一次，不 mock reader", { timeout: 15_000 }, async () => {
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const request = new Promise<void>(resolve => {
        requested = resolve;
    });
    await withPage(
        async page => {
            const pending = selectTicketPlusSession(page, settings, { ...options, clickTimeoutMs: 2_000 });
            await Promise.race([request, pending]);
            // 導頁回應尚未釋放時不 evaluate 舊頁，避免等待新文件造成測試死鎖。
            release();
            const result = await pending;
            assert.equal(result.sessionId, "session-B");
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        {
            beforeOrder: async () => {
                requested();
                await gate;
            },
        },
    );
});

test("TicketPlus 場次：未知彈窗在點擊前停止，隱藏殘留不阻擋", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, { ...options, clickTimeoutMs: 100 }),
                "before-click",
                "unexpected-page",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        {
            html:
                activity +
                '<div role="dialog" style="position:fixed;inset:0;z-index:99;background:white"><input type="password"><button>登入</button></div>',
        },
    );
    await withPage(
        async page => {
            assert.equal((await selectTicketPlusSession(page, settings, options)).sessionId, "session-B");
        },
        { html: activity + '<div role="dialog" hidden><input type="password"><button>登入</button></div>' },
    );
});

test("TicketPlus 場次：讀後重排、改名與新增同時間列，重新核對不使用舊快照", { timeout: 15_000 }, async () => {
    for (const mode of ["reorder", "rename", "duplicate", "different-name-duplicate", "remove"] as const) {
        await withPage(async page => {
            // 真 DOM getter 在首份快照完成取值後變動列表，第二份快照必須重新檢查。
            await page.evaluate(mode => {
                const title = document.querySelector("h1")! as HTMLElement;
                const text = title.innerText;
                let changed = false;
                Object.defineProperty(title, "innerText", {
                    get() {
                        if (!changed) {
                            changed = true;
                            const row = document.querySelector('[data-fixture="B"]')!;
                            if (mode === "reorder") row.parentElement!.prepend(row);
                            if (mode === "rename") {
                                row.querySelector(".font-weight-bold.is-word-break")!.textContent = "更名場次";
                            }
                            if (mode === "duplicate") row.after(row.cloneNode(true));
                            if (mode === "different-name-duplicate") {
                                const duplicate = row.cloneNode(true) as Element;
                                duplicate.querySelector(".font-weight-bold.is-word-break")!.textContent =
                                    "同時間的 C 場次";
                                row.after(duplicate);
                            }
                            if (mode === "remove") row.remove();
                        }
                        return text;
                    },
                });
            }, mode);
            if (mode === "reorder") {
                assert.equal((await selectTicketPlusSession(page, settings, options)).sessionId, "session-B");
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            } else {
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, options),
                    "before-click",
                    mode === "different-name-duplicate" ? "session-ambiguous" : undefined,
                );
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            }
        });
    }
});

test("TicketPlus 場次：點擊已送出但導頁逾時仍只點一次", { timeout: 15_000 }, async () => {
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const request = new Promise<void>(resolve => {
        requested = resolve;
    });
    await withPage(
        async page => {
            const pending = selectTicketPlusSession(page, settings, { ...options, clickTimeoutMs: 150 });
            const rejected = rejectsEntry(pending, "after-click-attempt", "click-failed");
            try {
                await Promise.race([request, rejected]);
                await rejected;
            } finally {
                release();
            }
            await page.waitForURL(`${origin}/order/event-fixture/session-B`);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        {
            beforeOrder: async () => {
                requested();
                await gate;
            },
        },
    );
});

test("TicketPlus 場次：關閉頁面回固定錯誤，不帶出原始 Playwright 訊息", { timeout: 15_000 }, async () => {
    await withPage(async page => {
        await page.close();
        await rejectsEntry(selectTicketPlusSession(page, settings, options), "before-click", "unexpected-page");
    });
});

test("TicketPlus 場次：目標尚未開賣不點其他可買場次，其他尚未開賣不阻擋目標", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsEntry(selectTicketPlusSession(page, settings, options), "before-click", "not-on-sale");
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: heading + rowA + rowB.replace("立即購買", "尚未開賣") },
    );
    await withPage(
        async page => {
            assert.equal((await selectTicketPlusSession(page, settings, options)).sessionId, "session-B");
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { html: heading + rowA.replace("立即購買", "尚未開賣") + rowB },
    );
});

test("TicketPlus 場次：未知或矛盾按鈕與同時段預售重複列皆零點擊", { timeout: 15_000 }, async () => {
    for (const [html, reason] of [
        [heading + rowB.replace("立即購買", "未知操作"), "activity-ready-timeout"],
        [heading + rowB.replace("</button>", "</button><button>尚未開賣</button>"), "activity-ready-timeout"],
        [activity + rowB.replace("立即購買", "尚未開賣"), "session-ambiguous"],
    ] as const) {
        await withPage(
            async page => {
                const result = selectTicketPlusSession(page, settings, {
                    ...options,
                    activityReadyTimeoutMs: 300,
                    activityPollIntervalMs: 30,
                });
                if (reason === "activity-ready-timeout") {
                    await assert.rejects(result, error => {
                        assert(error instanceof TicketPlusSessionError);
                        assert.equal(error.stage, "before-click");
                        // 期限可能落在最後讀取中；兩種結果都須證明先等待而非立即拒絕。
                        assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                        assert.equal(error.diagnostic?.check, "page-state");
                        if (error.diagnostic?.check !== "page-state") return false;
                        assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
                        assert(error.diagnostic.activityWait!.elapsedMs >= 250);
                        assert(error.diagnostic.activityWait!.observations > 1);
                        return true;
                    });
                } else {
                    await rejectsEntry(result, "before-click", reason);
                }
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            },
            { html },
        );
    }
});

test("TicketPlus 場次診斷：保留失敗快照與分類，仍只點一次且不洩漏文字", { timeout: 30_000 }, async () => {
    const cases = [
        {
            html: orderB + '<div role="dialog">PRIVATE_DIALOG_TEXT</div>',
            kind: "unknown",
            reason: "blocking-dialog",
            marker: "unknownDialogs",
        },
        {
            html: orderB + '<div class="stepText checkedStep">付款結帳</div>',
            kind: "unknown",
            reason: "conflicting-page",
            marker: "checkoutSteps",
        },
        { html: fixture.queue, kind: "queue", reason: undefined, marker: "queueHeadings" },
    ];
    for (const item of cases) {
        await withPage(
            async page => {
                await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "unexpected-page");
                    assert.equal(error.stage, "after-click-attempt");
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    assert.equal(error.diagnostic.snapshot.pageKind, item.kind);
                    assert.equal(error.diagnostic.snapshot.unknownReason, item.reason);
                    assert.equal(Reflect.get(error.diagnostic.snapshot.markers!, item.marker), 1);
                    assert.doesNotMatch(
                        JSON.stringify(error.diagnostic),
                        /PRIVATE_DIALOG_TEXT|https:|孿生|event-fixture/,
                    );
                    return true;
                });
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: item.html },
        );
    }
});

test("TicketPlus 場次診斷：網址拒絕只留下條件，不保存查詢內容", { timeout: 20_000 }, async () => {
    for (const [destination, reason] of [
        ["/order/another/session-B", "path-mismatch"],
        ["/order/event-fixture/session-B?token=PRIVATE_TOKEN", "extra-url-parts"],
    ]) {
        await withPage(
            async page => {
                await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "unexpected-page");
                    assert.deepEqual(error.diagnostic, { check: "arrival-route", reason });
                    return true;
                });
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { destinationB: destination },
        );
    }
});

test("TicketPlus 場次診斷：點擊前阻擋與等待逾時保留最後觀測", { timeout: 20_000 }, async () => {
    await withPage(
        async page => {
            await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
                assert(error instanceof TicketPlusSessionError);
                assert.equal(error.stage, "before-click");
                assert.equal(error.diagnostic?.check, "page-state");
                if (error.diagnostic?.check !== "page-state") return false;
                assert.equal(error.diagnostic.snapshot.unknownReason, "blocking-dialog");
                return true;
            });
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: activity + '<div role="dialog">請確認</div>' },
    );
    await withPage(
        async page => {
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 300 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "arrival-timeout");
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    assert.equal(error.diagnostic.snapshot.unknownReason, "incomplete-data");
                    assert.equal(error.diagnostic.snapshot.markers?.ticketRows, 0);
                    return true;
                },
            );
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: "<main>載入中</main>" },
    );
});

test("TicketPlus 入場過渡：同活動殘留列經空白載入到選票頁，只點一次", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            let transitionReads = 0;
            class TransitionControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    // 只有正式流程願意等待後，才推進模擬網站的載入階段。
                    if (page.url().endsWith("/order/event-fixture/session-B")) {
                        transitionReads++;
                        if (transitionReads === 1) {
                            assert.deepEqual(await readTicketPlusPage(page), {
                                kind: "unknown",
                                reason: "conflicting-page",
                            });
                            await page.setContent("<main>載入中</main>");
                        } else {
                            await page.setContent(orderB);
                        }
                    }
                    await super.wait(milliseconds);
                }
            }
            const result = await selectTicketPlusSession(page, settings, options, new TransitionControl());
            assert.equal(result.kind, "ticket-selection");
            assert.equal(result.sessionId, "session-B");
            assert.equal(transitionReads, 2);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: activity },
    );
});

test("TicketPlus 入場過渡：殘留不消失沿用期限停止，診斷保留過渡原因", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            const started = performance.now();
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 500 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "arrival-timeout");
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
                    assert.equal(error.diagnostic.snapshot.markers?.activityRows, 2);
                    return true;
                },
            );
            assert(performance.now() - started < 3_000);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: activity },
    );
});

test("TicketPlus 入場過渡：身分不符或跨流程標記立即停止", { timeout: 30_000 }, async () => {
    const cases = [
        activity.replace(`<h1>${eventName}</h1>`, "<h1>其他活動</h1>"),
        heading + rowA,
        activity.replace("晚場 [B] (特別)", "其他場次"),
        activity + rowB,
        activity + '<div role="dialog">請確認</div>',
        activity + "<h3>排隊購票中 請稍候</h3>",
        activity + "<div>聯絡人資訊</div>",
        activity + '<label>姓名<input value="PRIVATE_CONTACT"></label>',
        activity + orderB.replace("21:00", "22:00"),
        activity + "<button>前往付款</button>",
        activity + '<div class="stepText checkedStep">付款結帳</div>',
        activity + '<div class="row py-2 py-md-3 no-gutters">摘要</div>',
    ];
    for (const html of cases) {
        await withPage(
            async page => {
                let orderWaits = 0;
                class ObservedControl extends TicketPlusRunControl {
                    override async wait(milliseconds: number): Promise<void> {
                        if (page.url().includes("/order/")) orderWaits++;
                        await super.wait(milliseconds);
                    }
                }
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, options, new ObservedControl()),
                    "after-click-attempt",
                    "unexpected-page",
                );
                assert.equal(orderWaits, 0);
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: html },
        );
    }
});

test("TicketPlus 入場過渡：等待可停止，完成後仍核對選票場次", { timeout: 15_000 }, async () => {
    for (const stop of [true, false]) {
        await withPage(
            async page => {
                const controller = new AbortController();
                class TransitionControl extends TicketPlusRunControl {
                    override async wait(milliseconds: number): Promise<void> {
                        if (page.url().includes("/order/")) {
                            if (stop) controller.abort();
                            else await page.setContent(orderA);
                        }
                        await super.wait(milliseconds);
                    }
                }
                await assert.rejects(
                    selectTicketPlusSession(page, settings, options, new TransitionControl(controller.signal)),
                    error => {
                        if (stop) {
                            assert(error instanceof TicketPlusStopError);
                            assert.equal(error.stopReason, "user-stop");
                        } else {
                            assert(error instanceof TicketPlusSessionError);
                            assert.equal(error.reason, "arrival-mismatch");
                        }
                        return true;
                    },
                );
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: activity },
        );
    }
});

test("TicketPlus 入場診斷：保留原始欄位與等待決策，不輸出頁面文字", { timeout: 30_000 }, async () => {
    const cases = [
        { html: rowB, status: "pending", reason: "selection-not-ready", headings: 0 },
        {
            html: heading + rowB.replace("立即購買", "PRIVATE_LOADING_TEXT"),
            status: "pending",
            reason: "selection-not-ready",
            knownButton: false,
        },
        {
            html: activity.replace(`<h1>${eventName}</h1>`, "<h1>PRIVATE_EVENT</h1>"),
            status: "stop",
            reason: "event-name-mismatch",
        },
        { html: heading + rowA, status: "stop", reason: "activity-session-mismatch" },
        { html: activity + rowB, status: "stop", reason: "activity-session-mismatch" },
        {
            html: activity.replace("晚場 [B] (特別)", "PRIVATE_SESSION"),
            status: "stop",
            reason: "activity-session-mismatch",
        },
        {
            html: activity + '<div class="stepText checkedStep">付款結帳</div>',
            status: "stop",
            reason: "conflicting-content",
        },
    ];
    for (const item of cases) {
        await withPage(
            async page => {
                await assert.rejects(
                    selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 300 }),
                    error => {
                        assert(error instanceof TicketPlusSessionError);
                        assert.equal(error.reason, item.status === "pending" ? "arrival-timeout" : "unexpected-page");
                        if (error.diagnostic?.check !== "page-state") assert.fail();
                        const diagnostic = error.diagnostic.snapshot;
                        assert.deepEqual(diagnostic.readiness, { status: item.status, reason: item.reason });
                        if (item.headings !== undefined)
                            assert.equal(diagnostic.activityFields?.headings.count, item.headings);
                        if (item.knownButton !== undefined)
                            assert.equal(diagnostic.activityFields?.rows[0]?.knownButtonText, item.knownButton);
                        assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE_|孿生|event-fixture|晚場/);
                        return true;
                    },
                );
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: item.html },
        );
    }
});

test("TicketPlus 入場過渡：兩個相同目標標題可等待，仍只點一次", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            let observed = false;
            class TransitionControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    if (page.url().includes("/order/")) {
                        observed = true;
                        assert.deepEqual(await readTicketPlusPage(page), {
                            kind: "unknown",
                            reason: "conflicting-page",
                        });
                        await page.setContent(orderB);
                    }
                    await super.wait(milliseconds);
                }
            }
            const result = await selectTicketPlusSession(page, settings, options, new TransitionControl());
            assert.equal(observed, true);
            assert.equal(result.sessionId, "session-B");
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: heading + rowB + `<h1>${eventName}</h1>` },
    );
});

test("TicketPlus 入場過渡：重複標題持續存在仍逾時，保留原標題數量", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 300 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "arrival-timeout");
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    const diagnostic = error.diagnostic.snapshot;
                    assert.equal(diagnostic.readiness?.status, "pending");
                    assert.equal(diagnostic.activityFields?.headings.count, 2);
                    assert.equal(diagnostic.activityFields?.headings.matchingCount, 2);
                    return true;
                },
            );
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { orderB: heading + rowB + `<h1>${eventName}</h1>` },
    );
});

test("TicketPlus 重複標題：非目標標題、重複場次與點擊前歧義仍停止", { timeout: 20_000 }, async () => {
    for (const html of [
        heading + rowB + "<h1>其他活動</h1>",
        heading + rowB + `<h1>${eventName}</h1><div role="dialog">提示</div>`,
    ]) {
        await withPage(
            async page => {
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, options),
                    "after-click-attempt",
                    "unexpected-page",
                );
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: html },
        );
    }
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, { ...options, activityReadyTimeoutMs: 300 }),
                "before-click",
                "activity-ready-timeout",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: activity + `<h1>${eventName}</h1>` },
    );
});

test("TicketPlus 入場過渡：網址切換前後同名標題重疊，共用等待且只點一次", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await page.evaluate(name => {
                document.addEventListener(
                    "click",
                    () => {
                        const heading = document.createElement("h1");
                        heading.textContent = name;
                        document.body.append(heading);
                    },
                    { once: true },
                );
            }, eventName);
            let waits = 0;
            class TransitionControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    waits++;
                    assert.deepEqual(await readTicketPlusPage(page), {
                        kind: "unknown",
                        reason: waits === 1 ? "ambiguous-data" : "conflicting-page",
                    });
                    if (waits === 1) {
                        await page.evaluate(() => history.replaceState({}, "", "/order/event-fixture/session-B"));
                    } else {
                        await page.setContent(orderB);
                    }
                    await super.wait(milliseconds);
                }
            }
            const result = await selectTicketPlusSession(page, settings, options, new TransitionControl());
            assert.equal(result.sessionId, "session-B");
            assert.equal(waits, 2);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { noNavigation: true },
    );
});

test("TicketPlus 活動網址過渡：持續重疊逾時，不重按並保留驗證結果", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await page.evaluate(name => {
                document.addEventListener(
                    "click",
                    () => {
                        const heading = document.createElement("h1");
                        heading.textContent = name;
                        document.body.append(heading);
                    },
                    { once: true },
                );
            }, eventName);
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 300 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.reason, "arrival-timeout");
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    assert.equal(error.diagnostic.snapshot.readiness?.reason, "selection-not-ready");
                    assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
                    return true;
                },
            );
            assert.equal(page.url(), activityUrl);
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { noNavigation: true },
    );
});

test("TicketPlus 活動網址過渡：不同標題、重複場次與混合標記仍停止", { timeout: 20_000 }, async () => {
    for (const extra of ["<h1>另一活動</h1>", `<h1>${eventName}</h1><div role="dialog">提示</div>`]) {
        await withPage(
            async page => {
                await page.evaluate(html => {
                    document.addEventListener("click", () => document.body.insertAdjacentHTML("beforeend", html), {
                        once: true,
                    });
                }, extra);
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, options),
                    "after-click-attempt",
                    "unexpected-page",
                );
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { noNavigation: true },
        );
    }
});

test("TicketPlus 活動載入：空白與正確標題等待後才點一次，記錄觀測與耗時", async () => {
    for (const html of ["<main>載入中</main>", heading]) {
        await withPage(
            async page => {
                let waits = 0;
                const reports: { elapsedMs: number; observations: number }[] = [];
                class LoadingControl extends TicketPlusRunControl {
                    override async wait(milliseconds: number): Promise<void> {
                        assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
                        waits++;
                        await page.evaluate(content => {
                            document.body.innerHTML = content;
                        }, activity);
                        await super.wait(milliseconds);
                    }
                }
                const result = await selectTicketPlusSession(
                    page,
                    settings,
                    {
                        ...options,
                        activityPollIntervalMs: 20,
                        onActivityWait: report => reports.push(report),
                    },
                    new LoadingControl(),
                );
                assert.equal(result.sessionId, "session-B");
                assert.equal(waits, 1);
                assert.equal(reports.length, 1);
                assert.equal(reports[0]!.observations, 3);
                assert(reports[0]!.elapsedMs >= 20);
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { html },
        );
    }
});

test("TicketPlus 活動載入：持續空白有固定期限與診斷，不點擊", async () => {
    await withPage(
        async page => {
            const reports: { elapsedMs: number; observations: number }[] = [];
            const started = performance.now();
            await assert.rejects(
                selectTicketPlusSession(page, settings, {
                    ...options,
                    activityReadyTimeoutMs: 300,
                    activityPollIntervalMs: 30,
                    onActivityWait: report => reports.push(report),
                }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.stage, "before-click");
                    assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check === "page-state") {
                        assert.equal(error.diagnostic.snapshot.emptyActivityLoading, true);
                        assert.deepEqual(error.diagnostic.activityWait, reports[0]);
                    }
                    return true;
                },
            );
            assert.equal(reports.length, 1);
            assert(reports[0]!.observations >= 2);
            assert(reports[0]!.elapsedMs >= 290);
            assert(performance.now() - started < 2000);
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: "<main>載入中</main>" },
    );
});

test("TicketPlus 活動載入：錯標題和跨頁標記不等待", async () => {
    for (const html of [
        "<h1>其他活動</h1>",
        '<div role="dialog">未知提示</div>',
        '<label>姓名<input value="PRIVATE"></label>',
        "<button>下一步</button>",
        "<button>前往付款</button>",
        fixture.order,
    ]) {
        await withPage(
            async page => {
                let waits = 0;
                class ObservedControl extends TicketPlusRunControl {
                    override async wait(): Promise<void> {
                        waits++;
                    }
                }
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, options, new ObservedControl()),
                    "before-click",
                    "unexpected-page",
                );
                assert.equal(waits, 0);
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            },
            { html },
        );
    }
});

test("TicketPlus 活動載入：等待中取消或換活動，不點擊", async () => {
    for (const stop of [true, false]) {
        await withPage(
            async page => {
                const abort = new AbortController();
                let waits = 0;
                class LoadingControl extends TicketPlusRunControl {
                    override async wait(milliseconds: number): Promise<void> {
                        waits++;
                        if (stop) abort.abort();
                        else await page.evaluate(() => history.replaceState({}, "", "/activity/other"));
                        await super.wait(milliseconds);
                    }
                }
                await assert.rejects(
                    selectTicketPlusSession(
                        page,
                        settings,
                        {
                            ...options,
                            activityPollIntervalMs: 10,
                        },
                        new LoadingControl(abort.signal),
                    ),
                    error => {
                        if (stop) assert(error instanceof TicketPlusStopError);
                        else {
                            assert(error instanceof TicketPlusSessionError);
                            assert.equal(error.reason, "activity-mismatch");
                        }
                        return true;
                    },
                );
                assert.equal(waits, 1);
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            },
            { html: "<main>載入中</main>" },
        );
    }
});

test("TicketPlus 活動載入：複核退回空白可等待，且不重設初次期限", async () => {
    for (const completes of [true, false]) {
        await withPage(
            async page => {
                let waits = 0;
                let blanked = false;
                class RecheckControl extends TicketPlusRunControl {
                    override async read<T>(read: () => Promise<T>): Promise<T> {
                        const result = await super.read(read);
                        // 真按鈕啟用核對完成後模擬網站重新渲染；不替 reader 偽造答案。
                        if (result === true && !blanked) {
                            blanked = true;
                            await page.evaluate(() => {
                                document.body.innerHTML = "載入中";
                            });
                        }
                        return result;
                    }
                    override async wait(milliseconds: number): Promise<void> {
                        waits++;
                        if (waits === 1) {
                            await super.wait(400);
                            await page.evaluate(content => {
                                document.body.innerHTML = content;
                            }, activity);
                        } else {
                            if (completes)
                                await page.evaluate(content => {
                                    document.body.innerHTML = content;
                                }, activity);
                            await super.wait(milliseconds);
                        }
                    }
                }
                const started = performance.now();
                const pending = selectTicketPlusSession(
                    page,
                    settings,
                    {
                        ...options,
                        activityReadyTimeoutMs: 600,
                        activityPollIntervalMs: 20,
                    },
                    new RecheckControl(),
                );
                if (completes) {
                    assert.equal((await pending).sessionId, "session-B");
                    assert.equal(waits, 2);
                } else {
                    await assert.rejects(pending, error => {
                        assert(error instanceof TicketPlusSessionError);
                        assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                        return true;
                    });
                    assert(performance.now() - started < 850);
                }
                assert.equal(blanked, true);
                assert.deepEqual(await counts(page), { A: 0, B: completes ? 1 : 0, tab: 0, other: 0 });
            },
            { html: "載入中" },
        );
    }
});

test("TicketPlus 點擊前診斷：缺時間等待到期限，保留欄位與等待統計", async () => {
    await withPage(
        async page => {
            let waits = 0;
            class ObservedControl extends TicketPlusRunControl {
                override async wait(ms: number): Promise<void> {
                    waits++;
                    await super.wait(ms);
                }
            }
            await assert.rejects(
                selectTicketPlusSession(
                    page,
                    settings,
                    { ...options, activityReadyTimeoutMs: 300, activityPollIntervalMs: 30 },
                    new ObservedControl(),
                ),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.stage, "before-click");
                    assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                    assert.equal(error.diagnostic?.check, "page-state");
                    if (error.diagnostic?.check !== "page-state") return false;
                    const { snapshot, activityWait } = error.diagnostic;
                    assert.equal(snapshot.readFailure, undefined);
                    assert.equal(snapshot.unknownReason, "incomplete-data");
                    assert.equal(snapshot.emptyActivityLoading, false);
                    assert.deepEqual(snapshot.activityFields, {
                        headings: { count: 1, nonEmptyCount: 1, matchingCount: 1 },
                        rows: [
                            {
                                names: 1,
                                nameNonEmpty: true,
                                dateField: { labels: 1, values: 1 },
                                timeField: { labels: 1, values: 1 },
                                dates: 1,
                                dateValid: true,
                                times: 0,
                                timeValid: false,
                                buttons: 1,
                                knownButtonText: true,
                                buttonEnabled: true,
                            },
                        ],
                    });
                    assert(activityWait!.observations > 1);
                    assert.doesNotMatch(JSON.stringify(error.diagnostic), /孿生|PRIVATE|https:|event-fixture/);
                    return true;
                },
            );
            assert(waits > 0);
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: heading + rowB.replace("21:00", "PRIVATE_TIME") },
    );
});

test("TicketPlus 入場等待：殘缺與重疊內容到期限仍只點一次", async () => {
    for (const html of [
        activity.replace("21:00", "未知時間"),
        activity + orderB,
        heading + rowB + "<h1> </h1>",
        heading + rowB + rowB + `<h1>${eventName}</h1>`,
        "<button>下一步</button>",
    ]) {
        await withPage(
            async page => {
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, { ...options, arrivalTimeoutMs: 300 }),
                    "after-click-attempt",
                    "arrival-timeout",
                );
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            },
            { orderB: html },
        );
    }
});

test("TicketPlus 入場等待：獨立回應結束活動與選票重疊後才完成", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            let release!: () => void;
            let requested!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const request = new Promise<void>(resolve => {
                requested = resolve;
            });
            await page.route("**/selection-content", async route => {
                requested();
                await gate;
                await route.fulfill({ contentType: "text/html; charset=utf-8", body: orderB });
            });
            let settled = false;
            const outcome = selectTicketPlusSession(page, settings, options).then(
                value => {
                    settled = true;
                    return { value };
                },
                error => {
                    settled = true;
                    return { error };
                },
            );
            try {
                await request;
                await delay(250);
                assert.equal(settled, false);
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
                release();
                const result = await outcome;
                if ("error" in result) throw result.error;
                assert.equal(result.value.sessionId, "session-B");
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
            } finally {
                release();
                await outcome;
            }
        },
        {
            orderB:
                activity +
                orderB +
                '<script>fetch("/selection-content").then(r => r.text()).then(html => { document.body.innerHTML = html; });</script>',
        },
    );
});

test("近期觀測診斷：獨立故障注入保留最後八筆，讀取中斷仍立即停止且零點擊", async () => {
    await withPage(
        async page => {
            const originalEvaluate = page.evaluate.bind(page);
            let captures = 0;
            // 在第十二次 DOM 讀取注入例外；不根據正式程式回傳或設定產生故障。
            page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
                captures++;
                if (captures === 12) throw new Error("Execution context was destroyed, private@example.com");
                return originalEvaluate(...args);
            }) as Page["evaluate"];
            try {
                await assert.rejects(
                    selectTicketPlusSession(page, settings, {
                        ...options,
                        activityReadyTimeoutMs: 5_000,
                        activityPollIntervalMs: 1,
                    }),
                    error => {
                        assert(error instanceof TicketPlusSessionError);
                        assert.equal(error.stage, "before-click");
                        assert.equal(error.reason, "unexpected-page");
                        assert.equal(error.diagnostic?.check, "page-state");
                        if (error.diagnostic?.check !== "page-state") return false;
                        const history = error.diagnostic.recentObservations!;
                        assert.equal(history.length, 8);
                        assert.deepEqual(
                            history.map(item => item.observation),
                            [5, 6, 7, 8, 9, 10, 11, 12],
                        );
                        assert(history.every(item => item.stage === "before-click"));
                        assert(history.slice(0, -1).every(item => item.readiness?.status === "pending"));
                        assert(
                            history.every(
                                (item, index) => index === 0 || item.elapsedMs >= history[index - 1]!.elapsedMs,
                            ),
                        );
                        assert.equal(history.at(-1)?.readiness?.status, "stop");
                        assert.equal(history.at(-1)?.readFailure?.category, "navigation-interrupted");
                        assert.equal(history.at(-1)?.readFailure?.step, "capture-dom");
                        assert.equal(error.diagnostic.activityWait?.observations, 12);
                        assert(!JSON.stringify(error.diagnostic).includes("private@example.com"));
                        return true;
                    },
                );
                assert.equal(captures, 12);
            } finally {
                page.evaluate = originalEvaluate;
            }
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: "<h1></h1>" },
    );
});

test("TicketPlus 場次：等待中才出現的提醒先關閉一次，再點目標場次", { timeout: 15_000 }, async () => {
    for (const html of [
        activity + noticeDialog(noticeTitles.lottery) + noticeBehavior(),
        // 模擬 SPA：場次列晚於提醒才畫出，提醒在等待期間出現
        heading +
            delayedNotice(noticeTitles.entry, 100) +
            noticeBehavior() +
            `<script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(rowA + rowB)}), 400);</script>`,
    ]) {
        await withPage(
            async page => {
                const result = await selectTicketPlusSession(page, settings, options);
                assert.equal(result.sessionId, "session-B");
                // 「確定」計入 other；只點一次提醒、一次場次
                assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 1 });
            },
            { html },
        );
    }
});

test("TicketPlus 場次：提醒關閉後同一次載入又出現，停止且不點場次", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, options),
                "before-click",
                "notice-dismiss-failed",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 1 });
        },
        { html: activity + noticeDialog(noticeTitles.entry) + noticeBehavior("reappear") },
    );
    // 確認期間過後才重現：同一次載入的關閉額度已用完，不能再點
    await withPage(
        async page => {
            await rejectsEntry(
                selectTicketPlusSession(page, settings, options),
                "before-click",
                "notice-dismiss-failed",
            );
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 1 });
        },
        {
            html:
                heading +
                noticeDialog(noticeTitles.entry) +
                noticeBehavior("reappear-late") +
                `<script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(rowA + rowB)}), 1500);</script>`,
        },
    );
});

test("TicketPlus 場次：提醒與未知彈窗並存時零點擊停止", { timeout: 15_000 }, async () => {
    await withPage(
        async page => {
            await rejectsEntry(selectTicketPlusSession(page, settings, options), "before-click", "unexpected-page");
            assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
        },
        { html: activity + noticeDialog(noticeTitles.entry) + '<div role="dialog">未知提示</div>' + noticeBehavior() },
    );
});

test("TicketPlus 場次：抽選設定只點「立即登記」，按鈕與流程類型不符時零點擊停止", { timeout: 20_000 }, async () => {
    const lotteryActivity = heading.replace("立即購買", "立即登記") + (rowA + rowB).replaceAll("立即購買", "立即登記");

    // 抽選設定點「立即登記」一次
    await withPage(
        async page => {
            const result = await selectTicketPlusSession(page, settings, { ...options, flowType: "lottery" });
            assert.equal(result.sessionId, "session-B");
            assert.deepEqual(await counts(page), { A: 0, B: 1, tab: 0, other: 0 });
        },
        { html: lotteryActivity },
    );

    // 購票設定遇到「立即登記」、抽選設定遇到「立即購買」都在點擊前停止
    for (const [html, flowType] of [
        [lotteryActivity, "purchase"],
        [activity, "lottery"],
    ] as const) {
        await withPage(
            async page => {
                await rejectsEntry(
                    selectTicketPlusSession(page, settings, { ...options, flowType }),
                    "before-click",
                    "flow-mismatch",
                );
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            },
            { html },
        );
    }
});
