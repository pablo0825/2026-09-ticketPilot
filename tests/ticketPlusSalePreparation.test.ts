import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { prepareTicketPlusSale, TicketPlusSaleError } from "../src/platforms/ticketplus/salePreparation.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import type { TicketPlusSelection } from "../src/config/platforms/ticketplus/activitySettings.js";
import * as fixture from "./fixtures/ticketplus/pages.js";
import { noticeBehavior, noticeDialog, noticeTitles } from "./fixtures/ticketplus/activityNotice.js";

const saleAt = "2026-12-06T17:00:00+08:00";
const sale = Date.parse(saleAt);
const url = "https://ticketplus.com.tw/activity/event-fixture";
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: url,
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "學生票", quantity: 1 },
};
async function withSite(
    run: (page: Page, requests: number[]) => Promise<void>,
    html: (count: number) => string = () => fixture.activity,
    status = 200,
) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const requests: number[] = [];
        await page.addInitScript(() =>
            document.addEventListener("click", () => sessionStorage.setItem("clicked", "yes")),
        );
        await page.route("**/*", route => {
            requests.push(performance.now());
            return route.fulfill({ status, contentType: "text/html; charset=utf-8", body: html(requests.length) });
        });
        await page.goto(url);
        await run(page, requests);
        if (!page.isClosed()) assert.equal(await page.evaluate(() => sessionStorage.getItem("clicked")), null);
    } finally {
        await browser.close();
    }
}
function reason(value: string) {
    return (error: unknown) => error instanceof TicketPlusSaleError && error.reason === value;
}

test("開賣準備：預設提前一秒刷新，開賣前即使可購買仍等待，到點才完成", async () => {
    await withSite(async (page, requests) => {
        let now = sale - 2000;
        let finished = false;
        const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
            now: () => now,
        }).then(() => {
            finished = true;
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(requests.length, 1);
        now = sale - 1000;
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.equal(requests.length, 2);
        assert.equal(finished, false);
        now = sale;
        await pending;
        assert.equal(requests.length, 2);
    });
});

test("開賣準備：明確尚未開賣才再次刷新，兩次刷新起點至少三秒", async () => {
    await withSite(
        async (page, requests) => {
            await prepareTicketPlusSale(page, settings, { saleAt, advanceSeconds: 2 }, new TicketPlusRunControl(), {
                now: () => sale + 1,
            });
            assert.equal(requests.length, 3);
            assert(requests[2]! - requests[1]! >= 2990);
        },
        count =>
            count < 3 ? fixture.activity.replace("<span>立即購買</span>", "<span>尚未開賣</span>") : fixture.activity,
    );
});

test("開賣準備：已超過固定截止時間或錯誤網址完全不刷新", async () => {
    await withSite(async (page, requests) => {
        await assert.rejects(
            prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
                now: () => sale + 120_000,
            }),
            reason("sale-expired"),
        );
        assert.equal(requests.length, 1);
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session");
        await assert.rejects(
            prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => sale }),
            reason("unexpected-page"),
        );
        assert.equal(requests.length, 2);
    });
});

test("開賣準備：停用、活動不符與矛盾按鈕停止，不補刷", async () => {
    for (const [html, expected] of [
        [fixture.activity.replace('type="button"', 'type="button" disabled'), "session-disabled"],
        [fixture.activity.replaceAll("2026-10-30", "2026-10-31"), "session-missing"],
        [fixture.activity.replace("</button>", "</button><button>尚未開賣</button>"), "page-unrecognized"],
    ]) {
        await withSite(
            async (page, requests) => {
                await assert.rejects(
                    prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => sale }),
                    reason(expected!),
                );
                assert.equal(requests.length, 2);
            },
            () => html!,
        );
    }
});

test("開賣準備：HTTP失敗不重試；持續空白受截止時間限制，不當成尚未開賣", async () => {
    await withSite(
        async (page, requests) => {
            await assert.rejects(
                prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => sale }),
                reason("refresh-failed"),
            );
            assert.equal(requests.length, 2);
        },
        () => fixture.activity,
        503,
    );
    await withSite(
        async (page, requests) => {
            const started = performance.now();
            await assert.rejects(
                prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
                    now: () => sale + 119_700,
                }),
                error =>
                    error instanceof TicketPlusSaleError && ["sale-expired", "read-timeout"].includes(error.reason),
            );
            assert(performance.now() - started < 1500);
            assert.equal(requests.length, 2);
        },
        () => "<main>載入中</main>",
    );
});

test("開賣準備：手動停止與頁面關閉後不刷新", async () => {
    for (const action of ["stop", "close"]) {
        await withSite(async (page, requests) => {
            const abort = new AbortController();
            const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(abort.signal), {
                now: () => sale - 60_000,
            });
            const rejected = assert.rejects(
                pending,
                action === "stop" ? error => error instanceof TicketPlusStopError : reason("page-closed"),
            );
            if (action === "stop") abort.abort();
            else await page.close();
            await rejected;
            assert.equal(requests.length, 1);
        });
    }
});

test("開賣準備：提前兩秒生效，間隔中自行開賣則不補刷", async () => {
    await withSite(
        async (page, requests) => {
            let now = sale - 2500;
            let availabilityReached!: () => void;
            const availability = new Promise<void>(resolve => {
                availabilityReached = resolve;
            });
            const pending = prepareTicketPlusSale(
                page,
                settings,
                { saleAt, advanceSeconds: 2 },
                new TicketPlusRunControl(),
                {
                    now: () => now,
                    onStage: stage => {
                        if (stage === "waiting-for-availability") availabilityReached();
                    },
                },
            );
            await new Promise(resolve => setTimeout(resolve, 300));
            assert.equal(requests.length, 1);
            now = sale - 2000;
            await page.locator('[data-load="2"]').waitFor();
            assert.equal(requests.length, 2);
            now = sale;
            await availability;
            await page.getByRole("button", { name: "尚未開賣", exact: true }).evaluate(button => {
                button.textContent = "立即購買";
            });
            await pending;
            assert.equal(requests.length, 2);
        },
        count =>
            fixture.activity.replace("<span>立即購買</span>", "<span>尚未開賣</span>") +
            `<div data-load="${count}">loaded</div>`,
    );
});

test("開賣準備：時鐘倒退不延長已建立的截止期限", async () => {
    await withSite(
        async (page, requests) => {
            let now = sale + 119_600;
            const started = performance.now();
            const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
                now: () => now,
                onStage: stage => {
                    if (stage === "waiting-for-availability") now = sale - 60_000;
                },
            });
            await assert.rejects(pending, reason("sale-expired"));
            assert(performance.now() - started < 1500);
            assert.equal(requests.length, 2);
        },
        () => fixture.activity.replace("<span>立即購買</span>", "<span>尚未開賣</span>"),
    );
});

test("開賣準備：刷新已送出後停止，等待刷新收尾，不再讀取或刷新", async () => {
    const browser = await chromium.launch();
    let release!: () => void;
    try {
        const page = await browser.newPage();
        let requests = 0;
        let entered!: () => void;
        const requested = new Promise<void>(resolve => {
            entered = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await page.route("**/*", async route => {
            requests++;
            if (requests === 2) {
                entered();
                await gate;
            }
            await route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture.activity });
        });
        await page.goto(url);
        const abort = new AbortController();
        let settled = false;
        const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(abort.signal), {
            now: () => sale,
        });
        const rejected = assert.rejects(pending, TicketPlusStopError).then(() => {
            settled = true;
        });
        await requested;
        abort.abort();
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(settled, false);
        release();
        await rejected;
        assert.equal(requests, 2);
    } finally {
        release?.();
        await browser.close();
    }
});

test("開賣準備：刷新後短暫空白hydrate才完成，不補刷", async () => {
    await withSite(
        async (page, requests) => {
            await prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => sale });
            assert.equal(requests.length, 2);
        },
        count =>
            count === 1
                ? fixture.activity
                : `<main id="loading">載入中</main><script>setTimeout(() => {document.body.innerHTML = ${JSON.stringify(fixture.activity)}}, 100)</script>`,
    );
});

test("開賣準備：開賣前可買不沿用，到點變停用即停止；無效時鐘不刷新", async () => {
    await withSite(async (page, requests) => {
        await assert.rejects(
            prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => NaN }),
            reason("invalid-clock"),
        );
        assert.equal(requests.length, 1);
        let now = sale - 1000;
        let loaded!: () => void;
        let waits = 0;
        const waiting = new Promise<void>(resolve => {
            loaded = resolve;
        });
        const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
            now: () => now,
            onStage: stage => {
                if (stage === "waiting-for-sale" && ++waits === 2) loaded();
            },
        });
        const rejected = assert.rejects(pending, reason("session-disabled"));
        await waiting;
        await page.getByRole("button", { name: "立即購買", exact: true }).evaluate(button => {
            (button as HTMLButtonElement).disabled = true;
        });
        now = sale;
        await rejected;
        assert.equal(requests.length, 2);
    });
});

test("開賣準備：reload跨過剩餘截止期限，回應晚到也不接續操作", async () => {
    const browser = await chromium.launch();
    let release!: () => void;
    try {
        const page = await browser.newPage();
        let requests = 0;
        let entered!: () => void;
        let delivered!: () => void;
        const requested = new Promise<void>(resolve => {
            entered = resolve;
        });
        const delivery = new Promise<void>(resolve => {
            delivered = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await page.addInitScript(() =>
            document.addEventListener("click", () => sessionStorage.setItem("clicked", "yes")),
        );
        await page.route("**/*", async route => {
            requests++;
            const count = requests;
            if (count === 2) {
                entered();
                await gate;
            }
            await route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: fixture.activity + `<div data-late-load="${count}">loaded</div>`,
            });
            if (count === 2) delivered();
        });
        await page.goto(url);
        const started = performance.now();
        const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), {
            now: () => sale + 119_500,
        });
        const rejected = assert.rejects(pending, reason("sale-expired"));
        await requested;
        await rejected;
        assert(performance.now() - started < 1500);
        assert.equal(requests, 2);
        release();
        await delivery;
        await page.locator('[data-late-load="2"]').waitFor();
        assert.equal(requests, 2);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("clicked")), null);
    } finally {
        release?.();
        await browser.close();
    }
});

test("開賣準備：重試間隔內時鐘回撥，開賣前不補刷", async () => {
    await withSite(
        async (page, requests) => {
            let now = sale;
            let waiting!: () => void;
            const gate = new Promise<void>(resolve => {
                waiting = resolve;
            });
            const abort = new AbortController();
            const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(abort.signal), {
                now: () => now,
                onStage: stage => {
                    if (stage === "waiting-for-availability") {
                        now = sale - 60_000;
                        waiting();
                    }
                },
            });
            const rejected = assert.rejects(pending, TicketPlusStopError);
            await gate;
            await new Promise(resolve => setTimeout(resolve, 3300));
            assert.equal(requests.length, 2);
            abort.abort();
            await rejected;
        },
        () => fixture.activity.replace("<span>立即購買</span>", "<span>尚未開賣</span>"),
    );
});

test("開賣準備：到點讀取期間時鐘回撥，不放行可購買場次", async () => {
    await withSite(async (page, requests) => {
        let now = sale - 1000;
        let beforeSale!: () => void;
        const waiting = new Promise<void>(resolve => {
            beforeSale = resolve;
        });
        let stageCount = 0;
        const abort = new AbortController();
        let settled = false;
        const pending = prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(abort.signal), {
            now: () => now,
            onStage: stage => {
                if (stage === "waiting-for-sale" && ++stageCount === 2) beforeSale();
            },
        }).finally(() => {
            settled = true;
        });
        const rejected = assert.rejects(pending, TicketPlusStopError);
        await waiting;
        // 仍執行真實 DOM evaluate，只在回傳快照時調整注入時鐘，避免跨協定回呼競速。
        const evaluate = page.evaluate;
        let completedReads = 0;
        page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
            const result = await Reflect.apply(evaluate, page, args);
            completedReads++;
            now = sale - 60_000;
            return result;
        }) as Page["evaluate"];
        now = sale;
        await new Promise(resolve => setTimeout(resolve, 600));
        assert(completedReads > 0, "必須確實完成到點後的 DOM 讀取");
        assert.equal(settled, false);
        assert.equal(requests.length, 2);
        abort.abort();
        await rejected;
    });
});

async function withNoticeSite(run: (page: Page, requests: number[]) => Promise<void>, html: (count: number) => string) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const requests: number[] = [];
        await page.route("**/*", route => {
            requests.push(performance.now());
            return route.fulfill({ contentType: "text/html; charset=utf-8", body: html(requests.length) });
        });
        await page.goto(url);
        await run(page, requests);
    } finally {
        await browser.close();
    }
}

test("開賣準備：每次重載後的提醒各關閉一次，再讀取開賣狀態", async () => {
    await withNoticeSite(
        async (page, requests) => {
            await prepareTicketPlusSale(page, settings, { saleAt, advanceSeconds: 2 }, new TicketPlusRunControl(), {
                now: () => sale + 1,
            });
            assert.equal(requests.length, 3);
            const clicks = await page.evaluate(() => (window as unknown as { __noticeClicks: object }).__noticeClicks);
            assert.deepEqual(clicks, { ok: 1, back: 0 });
        },
        count =>
            (count < 3
                ? fixture.activity.replace("<span>立即購買</span>", "<span>尚未開賣</span>")
                : fixture.activity) +
            noticeDialog(noticeTitles.lottery) +
            noticeBehavior(),
    );
});

test("開賣準備：提醒按確定後仍不消失，停止並回報無法關閉，不再刷新", async () => {
    await withNoticeSite(
        async (page, requests) => {
            await assert.rejects(
                prepareTicketPlusSale(page, settings, { saleAt }, new TicketPlusRunControl(), { now: () => sale + 1 }),
                reason("notice-dismiss-failed"),
            );
            assert.equal(requests.length, 2);
        },
        () => fixture.activity + noticeDialog(noticeTitles.entry) + noticeBehavior("stuck"),
    );
});
