import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import { selectTicketPlusSession, TicketPlusSessionError } from "../src/platforms/ticketplus/sessionSelection.js";
import type { SessionEntryStage, SessionEntryReason } from "../src/platforms/ticketplus/sessionSelection.js";
import * as fixture from "./fixtures/ticketplus/pages.js";

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
        {
            html: activity.replace("<span>立即購買</span>", "<span>立即購買</span></button><button>立即購買"),
            reason: "unexpected-page",
        },
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
        [heading + rowB.replace("立即購買", "未知操作"), "unexpected-page"],
        [heading + rowB.replace("</button>", "</button><button>尚未開賣</button>"), "unexpected-page"],
        [activity + rowB.replace("立即購買", "尚未開賣"), "session-ambiguous"],
    ] as const) {
        await withPage(
            async page => {
                await rejectsEntry(selectTicketPlusSession(page, settings, options), "before-click", reason);
                assert.deepEqual(await counts(page), { A: 0, B: 0, tab: 0, other: 0 });
            },
            { html },
        );
    }
});
