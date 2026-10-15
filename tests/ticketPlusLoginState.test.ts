import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventEmitter } from "node:events";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusLoginState } from "../src/platforms/ticketplus/loginState.js";
import { TicketPlusLoginError, waitForTicketPlusLogin } from "../src/platforms/ticketplus/loginWait.js";
import { TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";

const member =
    '<div class="font-weight-bold">0912***345 <span class="primary-1--text ml-3 cursor-pointer">登出</span></div>';
const header = (content: string) => `<header class="headerApp" style="min-height:50px">${content}</header>`;
async function fixture(body: string, use: (page: Page) => Promise<void>, path = "/") {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.route("https://ticketplus.com.tw/**", route =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body }),
        );
        await page.goto(`https://ticketplus.com.tw${path}`);
        await use(page);
    } finally {
        await browser.close();
    }
}

test("登入快照：空白、單一標記、互相衝突及隱藏會員區不能當作登入成功", async () => {
    await fixture("", async page => {
        const cases = [
            ["", "unknown"],
            [header("<div>會員專區</div><svg><path /></svg>"), "unknown"],
            [header("<div>0912***345</div>"), "unknown"],
            [header('<span class="cursor-pointer">登出</span>'), "unknown"],
            [header(member), "logged-in"],
            [header('<div class="cursor-pointer">會員登入</div>'), "logged-out"],
            [header(member + "<div>會員登入</div>"), "unknown"],
            [header(member + member), "unknown"],
            [header(member) + '<div role="dialog">登入表單</div>', "unknown"],
            [header(`<div hidden>${member}</div>`), "unknown"],
            [
                header(member) + `<nav class="v-navigation-drawer v-navigation-drawer--close">${member}</nav>`,
                "logged-in",
            ],
            [
                header("") +
                    `<nav class="v-navigation-drawer v-navigation-drawer--close" style="position:fixed;transform:translateX(100%);right:0">${member}</nav>`,
                "unknown",
            ],
        ];
        for (const [html, expected] of cases) {
            await page.setContent(html!);
            const state = await readTicketPlusLoginState(page);
            assert.equal(state.state, expected, html!);
            assert(!JSON.stringify(state).includes("0912"));
        }
        await page.setContent(
            header("") +
                `<nav class="v-navigation-drawer" style="position:fixed;transform:translateX(100%);right:0">${member}</nav>`,
        );
        const offscreen = await readTicketPlusLoginState(page);
        assert.equal(offscreen.markers.headers, 1);
        assert.equal(offscreen.markers.openDrawers, 0);
        assert.equal(offscreen.state, "unknown");
        await page.locator("nav").evaluate(element => {
            (element as HTMLElement).style.transform = "none";
        });
        const visible = await readTicketPlusLoginState(page);
        assert.equal(visible.markers.headers, 1);
        assert.equal(visible.markers.openDrawers, 1);
        assert.equal(visible.state, "logged-in");
    });
});

test("登入快照：活動邊界需明確允許，訂單頁不可辨識登入", async () => {
    await fixture(
        header(member),
        async page => {
            assert.equal((await readTicketPlusLoginState(page)).reason, "unexpected-route");
            assert.equal((await readTicketPlusLoginState(page, { allowActivity: true })).state, "logged-in");
        },
        "/activity/example",
    );
    await fixture(
        header(member),
        async page => {
            assert.equal((await readTicketPlusLoginState(page, { allowActivity: true })).reason, "unexpected-route");
        },
        "/order/event/session",
    );
});

test("登入等待：外部釋放畫面後才成功，空白不能觸發人工登入通知", async () => {
    await fixture(header(""), async page => {
        let waiting = 0;
        const seen: string[] = [];
        let observedUnknown = () => {};
        const unknownSeen = new Promise<void>(resolve => {
            observedUnknown = resolve;
        });
        let observedWaiting = () => {};
        const waitingSeen = new Promise<void>(resolve => {
            observedWaiting = resolve;
        });
        const result = waitForTicketPlusLogin(page, {
            pageTimeoutMs: 2000,
            loginTimeoutMs: 2000,
            pollIntervalMs: 10,
            onWaiting: () => {
                waiting++;
                observedWaiting();
            },
            onObservation: value => {
                seen.push(value.state);
                if (value.state === "unknown") observedUnknown();
            },
        });
        await Promise.race([unknownSeen, result.then(() => assert.fail("不能跳過空白觀測"))]);
        assert.equal(waiting, 0);
        await page.setContent(header("<div>會員登入</div>"));
        await Promise.race([waitingSeen, result.then(() => assert.fail("不能跳過未登入觀測"))]);
        assert.equal(waiting, 1);
        await page.setContent(header(member));
        const summary = await result;
        assert.equal(summary.lastObservation?.state, "logged-in");
        assert(summary.observations >= 3);
        assert(seen.includes("unknown"));
        assert.equal(page.url(), "https://ticketplus.com.tw/");
    });
});

test("登入等待：窄版僅展開一次選單，不點登入或登出", async () => {
    const html =
        header(
            "<button class=\"mdi-menu\" onclick=\"window.menuClicks=(window.menuClicks||0)+1;document.querySelector('nav').classList.remove('v-navigation-drawer--close')\">選單</button>",
        ) +
        `<nav class="v-navigation-drawer v-navigation-drawer--close"><div class="drawerItem">0912***345 <span class="ml-3 cursor-pointer" onclick="window.logoutClicks=1">登出</span></div></nav>`;
    await fixture(html, async page => {
        const result = await waitForTicketPlusLogin(page, { pageTimeoutMs: 1000, pollIntervalMs: 10 });
        assert.equal(result.lastObservation?.state, "logged-in");
        assert.deepEqual(
            await page.evaluate(() => ({
                menu: (window as any).menuClicks,
                logout: (window as any).logoutClicks ?? 0,
            })),
            { menu: 1, logout: 0 },
        );
    });
});

test("登入等待：未知逾時、人工逾時、開賣截止與取消均有界且不導覽", async () => {
    await fixture(header(""), async page => {
        await assert.rejects(
            waitForTicketPlusLogin(page, { pageTimeoutMs: 40, pollIntervalMs: 5 }),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "page-timeout",
        );
        await page.setContent(header("<div>會員登入</div>"));
        await assert.rejects(
            waitForTicketPlusLogin(page, { loginTimeoutMs: 40, pollIntervalMs: 5 }),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "login-timeout",
        );
        await assert.rejects(
            waitForTicketPlusLogin(page, { deadline: Date.now() + 40, pollIntervalMs: 5 }),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "sale-expired",
        );
        const controller = new AbortController();
        const result = waitForTicketPlusLogin(page, { signal: controller.signal });
        controller.abort();
        await assert.rejects(result, TicketPlusStopError);
        assert.equal(page.url(), "https://ticketplus.com.tw/");
    });
});

test("登入等待：讀取懸掛、非導航錯誤與關頁立即停止，不輸出例外內容", async () => {
    await fixture(header(member), async page => {
        const original = page.evaluate.bind(page);
        page.evaluate = (() => new Promise(() => {})) as Page["evaluate"];
        await assert.rejects(
            waitForTicketPlusLogin(page, { readTimeoutMs: 30 }),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "read-timeout",
        );
        page.evaluate = (async () => {
            throw new Error("PRIVATE_SECRET");
        }) as Page["evaluate"];
        await assert.rejects(
            waitForTicketPlusLogin(page),
            (error: unknown) =>
                error instanceof TicketPlusLoginError &&
                error.reason === "read-failed" &&
                !JSON.stringify(error).includes("PRIVATE_SECRET"),
        );
        page.evaluate = original;
        await page.close();
        await assert.rejects(
            waitForTicketPlusLogin(page),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "page-closed",
        );
    });
});

test("登入等待：僅明確導航中斷可重讀，晚到資料與崩潰不會成功", async () => {
    await fixture(header(member), async page => {
        const original = page.evaluate.bind(page);
        let reads = 0;
        page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
            reads++;
            if (reads === 1) throw new Error("Execution context was destroyed, most likely because of a navigation.");
            return original(...args);
        }) as Page["evaluate"];
        const result = await waitForTicketPlusLogin(page, { pollIntervalMs: 5 });
        assert.equal(result.observations, 2);
        let resolveLate: ((value: unknown) => void) | undefined;
        page.evaluate = (() =>
            new Promise(resolve => {
                resolveLate = resolve;
            })) as Page["evaluate"];
        const crashed = waitForTicketPlusLogin(page, { readTimeoutMs: 1000 });
        (page as unknown as EventEmitter).emit("crash", page);
        await assert.rejects(
            crashed,
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "page-crashed",
        );
        resolveLate?.({ headers: 1, accounts: 1, logouts: 1, logins: 0, dialogs: 0, menuButtons: 0, openDrawers: 0 });
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(page.url(), "https://ticketplus.com.tw/");
        page.evaluate = original;
    });
});

test("登入等待：狀態反覆不延長人工期限，時鐘回撥不延長開賣期限", async () => {
    await fixture(header("<div>會員登入</div>"), async page => {
        let waiting = 0;
        const pending = waitForTicketPlusLogin(page, {
            pageTimeoutMs: 1000,
            loginTimeoutMs: 120,
            pollIntervalMs: 5,
            onWaiting: () => waiting++,
        });
        const stopped = assert.rejects(
            pending,
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "login-timeout",
        );
        await new Promise(resolve => setTimeout(resolve, 30));
        await page.setContent(header(""));
        await new Promise(resolve => setTimeout(resolve, 30));
        await page.setContent(header("<div>會員登入</div>"));
        await stopped;
        assert.equal(waiting, 1);
        let clock = 1000;
        const sale = waitForTicketPlusLogin(page, { deadline: 1080, now: () => clock, pollIntervalMs: 5 });
        const expired = assert.rejects(
            sale,
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "sale-expired",
        );
        clock = 500;
        await expired;
    });
});

test("登入等待：遮罩阻擋選單後不留下待點擊工作，取消後移除遮罩也不補點", async () => {
    const html =
        header('<button class="mdi-menu" onclick="window.menuClicks=(window.menuClicks||0)+1">選單</button>') +
        '<div id="mask" style="position:fixed;inset:0;z-index:100;background:white"></div>';
    await fixture(html, async page => {
        const controller = new AbortController();
        await assert.rejects(
            waitForTicketPlusLogin(page, { signal: controller.signal }),
            (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "menu-failed",
        );
        controller.abort();
        await page.locator("#mask").evaluate(element => element.remove());
        assert.equal(await page.evaluate(() => (window as any).menuClicks ?? 0), 0);
        const beforeMenu = new AbortController();
        await assert.rejects(
            waitForTicketPlusLogin(page, { signal: beforeMenu.signal, onObservation: () => beforeMenu.abort() }),
            TicketPlusStopError,
        );
        assert.equal(await page.evaluate(() => (window as any).menuClicks ?? 0), 0);
    });
});

test("登入停止診斷：取消前無觀測、讀取懸掛及通知失敗均保留原停止原因", async () => {
    await fixture(header("<div>會員登入</div>"), async page => {
        const pre = new AbortController();
        pre.abort();
        let empty: import("../src/platforms/ticketplus/loginWait.js").TicketPlusLoginSummary | undefined;
        await assert.rejects(
            waitForTicketPlusLogin(page, {
                signal: pre.signal,
                onStopped: summary => {
                    empty = summary;
                    throw new Error("PRIVATE_NOTIFICATION");
                },
            }),
            TicketPlusStopError,
        );
        assert.equal(empty?.observations, 0);
        assert.equal(empty?.lastObservation, undefined);

        const original = page.evaluate.bind(page);
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let reads = 0;
        let stopNotifications = 0;
        let finished = () => {};
        const lateRead = new Promise<void>(resolve => {
            finished = resolve;
        });
        page.evaluate = (async (...args: any[]) => {
            reads++;
            await gate;
            try {
                return await (original as any)(...args);
            } finally {
                finished();
            }
        }) as typeof page.evaluate;
        let stopped: import("../src/platforms/ticketplus/loginWait.js").TicketPlusLoginSummary | undefined;
        try {
            await assert.rejects(
                waitForTicketPlusLogin(page, {
                    readTimeoutMs: 40,
                    onStopped: async summary => {
                        stopNotifications++;
                        stopped = summary;
                        throw new Error("PRIVATE_NOTIFICATION");
                    },
                }),
                (error: unknown) => error instanceof TicketPlusLoginError && error.reason === "read-timeout",
            );
            assert.equal(reads, 1);
            assert.equal(stopped?.observations, 0);
            assert.equal(stopped?.lastObservation, undefined);
            const saved = JSON.stringify(stopped);
            release();
            await lateRead;
            assert.equal(stopNotifications, 1);
            assert.equal(JSON.stringify(stopped), saved);
        } finally {
            release();
            page.evaluate = original;
        }
    });
});

test("登入停止診斷：第二次讀取中取消保留前次快照，晚到結果不改摘要", async () => {
    await fixture(header("<div>會員登入</div>"), async page => {
        const original = page.evaluate.bind(page);
        const controller = new AbortController();
        let release = () => {};
        let entered = () => {};
        let finished = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const reading = new Promise<void>(resolve => {
            entered = resolve;
        });
        const lateRead = new Promise<void>(resolve => {
            finished = resolve;
        });
        let reads = 0;
        let notifications = 0;
        let stopped: import("../src/platforms/ticketplus/loginWait.js").TicketPlusLoginSummary | undefined;
        page.evaluate = (async (...args: any[]) => {
            reads++;
            if (reads === 1) return (original as any)(...args);
            entered();
            await gate;
            try {
                return await (original as any)(...args);
            } finally {
                finished();
            }
        }) as typeof page.evaluate;
        try {
            const waiting = waitForTicketPlusLogin(page, {
                signal: controller.signal,
                pollIntervalMs: 10,
                onStopped: summary => {
                    notifications++;
                    stopped = summary;
                },
            });
            const rejected = assert.rejects(waiting, TicketPlusStopError);
            await reading;
            controller.abort();
            await rejected;
            assert.equal(stopped?.observations, 1);
            assert.equal(stopped?.lastObservation?.state, "logged-out");
            const saved = JSON.stringify(stopped);
            await page.setContent(header(member));
            release();
            await lateRead;
            assert.equal(reads, 2);
            assert.equal(notifications, 1);
            assert.equal(JSON.stringify(stopped), saved);
        } finally {
            release();
            controller.abort();
            page.evaluate = original;
        }
    });
});
