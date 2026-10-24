import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusActivityObservation, readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { selectTicketPlusSession, TicketPlusSessionError } from "../src/platforms/ticketplus/sessionSelection.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import type { TicketPlusSelection } from "../src/config/platforms/ticketplus/activitySettings.js";
import { activity, order, session } from "./fixtures/ticketplus/pages.js";
import { loadingSession } from "./fixtures/ticketplus/activityLoading.js";

const eventName = "2026孿生姐妹之夜之鬼迷心竅";
const activityUrl = "https://ticketplus.com.tw/activity/event-fixture";
const orderUrl = "https://ticketplus.com.tw/order/event-fixture/session-A";
const target = { eventId: "event-fixture", eventName };
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: activityUrl,
    eventName,
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
const options = { activityReadyTimeoutMs: 3_000, activityPollIntervalMs: 30, arrivalTimeoutMs: 2_000 };
const emptyHeading = '<h1 style="min-height:20px"></h1>';
const heading = `<h1>${eventName}</h1>`;

async function withPage(html: string, run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.addInitScript(() => {
            document.addEventListener(
                "click",
                event => {
                    const button = (event.target as Element).closest("button");
                    if (!button) return;
                    const clicks: string[] = JSON.parse(sessionStorage.getItem("clicks") ?? "[]");
                    clicks.push(`${document.body.dataset.phase ?? "initial"}:${button.textContent?.trim()}`);
                    sessionStorage.setItem("clicks", JSON.stringify(clicks));
                    if (button.closest(".sesstion-item")) location.href = "/order/event-fixture/session-A";
                },
                true,
            );
        });
        await page.route("**/*", route =>
            route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: new URL(route.request().url()).pathname.startsWith("/order/") ? order : html,
            }),
        );
        await page.goto(activityUrl);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function clicks(page: Page): Promise<string[]> {
    return page.evaluate(() => JSON.parse(sessionStorage.getItem("clicks") ?? "[]"));
}

async function expectBlocked(page: Page): Promise<void> {
    const started = performance.now();
    await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
        assert(error instanceof TicketPlusSessionError);
        assert.equal(error.stage, "before-click");
        assert.equal(error.reason, "unexpected-page");
        assert.equal(error.diagnostic?.check, "page-state");
        if (error.diagnostic?.check === "page-state") {
            assert.equal(error.diagnostic.activityWait?.observations, 1);
            assert.equal(error.diagnostic.snapshot.activityLoading, "none");
        }
        return true;
    });
    assert(performance.now() - started < 1500);
    assert.deepEqual(await clicks(page), []);
}

test("活動佔位：獨立延遲回應完成後才點擊，標題空白與先完成皆可等", async () => {
    for (const initial of [
        emptyHeading + loadingSession,
        heading + loadingSession,
        heading + heading + loadingSession,
        heading + '<div class="sesstion-item"></div>',
    ]) {
        await withPage(initial, async page => {
            let release!: () => void;
            let requested!: () => void;
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const request = new Promise<void>(resolve => {
                requested = resolve;
            });
            // 測試網站依回應更新 DOM，與正式程式的 wait/read 呼叫無關。
            await page.route("**/fixture-content", async route => {
                requested();
                await gate;
                await route.fulfill({ contentType: "text/html; charset=utf-8", body: activity });
            });
            await page.evaluate(() => {
                document.body.dataset.phase = "placeholder";
                void fetch("/fixture-content")
                    .then(response => response.text())
                    .then(html => {
                        document.body.innerHTML = html;
                        document.body.dataset.phase = "complete";
                    });
            });
            await request;
            const pending = selectTicketPlusSession(page, settings, options);
            // 先掛接拒絕處理，避免早退失敗變成未處理 rejection。
            const outcome = pending.then(
                value => ({ value }),
                error => ({ error }),
            );
            try {
                await delay(350);
                assert.deepEqual(await clicks(page), []);
                release();
                const result = await outcome;
                if ("error" in result) throw result.error;
                assert.equal(result.value.sessionId, "session-A");
                assert.equal(page.url(), orderUrl);
                assert.deepEqual(await clicks(page), ["complete:立即購買"]);
            } finally {
                release();
                await outcome;
            }
        });
    }
});

test("活動佔位：專用觀測不依賴診斷，嚴格 reader 仍拒絕，不硬編碼日期", async () => {
    const html = heading + loadingSession.replace("2024-05-20", "2025-06-01").replace("2024-12-31", "2025-11-30");
    await withPage(html, async page => {
        const strict = await readTicketPlusPage(page);
        assert.deepEqual(strict, { kind: "unknown", reason: "ambiguous-data" });
        const withoutLog = await readTicketPlusActivityObservation(page, target);
        const brokenLog = await readTicketPlusActivityObservation(page, target, () => {
            throw new Error("log failed");
        });
        assert.deepEqual(withoutLog, {
            page: { kind: "unknown", reason: "incomplete-data" },
            loading: "loading-placeholder",
            readiness: { status: "pending", reason: "activity-not-ready" },
        });
        assert.deepEqual(brokenLog, withoutLog);
        assert.equal((await readTicketPlusActivityObservation(page, { ...target, eventId: "wrong" })).loading, "none");
        assert.deepEqual(await clicks(page), []);
    });
});

test("活動佔位：永久佔位沿用期限，保留固定原因與統計且零點擊", async () => {
    await withPage(heading + loadingSession, async page => {
        const started = performance.now();
        await assert.rejects(
            selectTicketPlusSession(page, settings, { ...options, activityReadyTimeoutMs: 350 }),
            error => {
                assert(error instanceof TicketPlusSessionError);
                assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                assert.equal(error.stage, "before-click");
                if (error.diagnostic?.check !== "page-state") assert.fail();
                assert.equal(error.diagnostic.snapshot.readFailure, undefined);
                assert.equal(error.diagnostic.snapshot.activityLoading, "loading-placeholder");
                assert.equal(error.diagnostic.snapshot.emptyActivityLoading, false);
                assert(error.diagnostic.activityWait!.observations > 1);
                assert(error.diagnostic.activityWait!.elapsedMs >= 340);
                assert.doesNotMatch(JSON.stringify(error.diagnostic), /2024|Loading\.\.\.|孿生|https:/);
                return true;
            },
        );
        assert(performance.now() - started < 1500);
        assert.deepEqual(await clicks(page), []);
    });
});

test("活動等待：殘缺與重複同名內容只等待到期限，始終零點擊", async () => {
    const cases = [
        heading + loadingSession.replace("19:00 ~ 23:59", "PRIVATE_TIME"),
        heading + loadingSession.replace("19:00 ~ 23:59", "25:00 ~ 26:00"),
        heading + loadingSession.replace("2024-12-31(二)", "2024-05-20(一)"),
        heading + loadingSession.replace("2024-05-20", "2024-02-30"),
        heading + loadingSession.replace("立即購買", "未知按鈕"),
        heading + loadingSession.replace("</button>", "</button><button>立即購買</button>"),
        heading + loadingSession + loadingSession,
        heading + heading + loadingSession,
    ];
    for (const html of cases) {
        await withPage(html, async page => {
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, activityReadyTimeoutMs: 250 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert.equal(error.stage, "before-click");
                    assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                    if (error.diagnostic?.check !== "page-state") assert.fail();
                    assert.equal(error.diagnostic.snapshot.readFailure, undefined);
                    assert(error.diagnostic.activityWait!.observations > 1);
                    assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
                    return true;
                },
            );
            assert.deepEqual(await clicks(page), []);
        });
    }
});

const otherSession = session.replace(eventName, "其他場次");
const progressSession = otherSession.replace(
    '<button type="button"><span>立即購買</span></button>',
    '<div role="progressbar"><svg><circle r="1"></circle></svg></div>',
);

test("活動等待：列表已完整載入但無同名場次時立即停止，零點擊", async () => {
    const cases = [
        heading + otherSession,
        heading + otherSession + otherSession.replace("其他場次", "第三場次"),
        heading + otherSession.replace("<span>立即購買</span>", "<span>立即登記</span>"),
        heading +
            otherSession.replace(
                '<button type="button"><span>立即購買</span>',
                '<button type="button" disabled><span>尚未開賣</span>',
            ),
    ];
    for (const html of cases) {
        await withPage(html, async page => {
            const started = performance.now();
            await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
                assert(error instanceof TicketPlusSessionError);
                assert.equal(error.stage, "before-click");
                assert.equal(error.reason, "session-missing");
                if (error.diagnostic?.check !== "page-state") assert.fail();
                assert.deepEqual(error.diagnostic.snapshot.readiness, { status: "stop", reason: "session-missing" });
                assert.equal(error.diagnostic.activityWait!.observations, 1);
                return true;
            });
            assert(performance.now() - started < 1500);
            assert.deepEqual(await clicks(page), []);
        });
    }
});

test("活動等待：列表仍在載入且無同名場次時等待到期限，零點擊", async () => {
    const cases = [
        heading,
        heading + progressSession,
        heading + otherSession + progressSession,
        heading + otherSession + loadingSession,
        heading + otherSession + loadingSession.replaceAll("Loading...", "Loading…"),
        heading + loadingSession.replaceAll("Loading...", "真實場次"),
        heading + otherSession + otherSession.replace("其他場次", ""),
    ];
    for (const html of cases) {
        await withPage(html, async page => {
            await assert.rejects(
                selectTicketPlusSession(page, settings, { ...options, activityReadyTimeoutMs: 250 }),
                error => {
                    assert(error instanceof TicketPlusSessionError);
                    assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                    if (error.diagnostic?.check !== "page-state") assert.fail();
                    assert.equal(error.diagnostic.snapshot.readFailure, undefined);
                    assert.deepEqual(error.diagnostic.snapshot.readiness, {
                        status: "pending",
                        reason: "activity-not-ready",
                    });
                    assert(error.diagnostic.activityWait!.observations > 1);
                    return true;
                },
            );
            assert.deepEqual(await clicks(page), []);
        });
    }
});

test("活動等待：載入中稍後出現的同名場次仍可找到，只點一次", async () => {
    for (const initial of [heading + progressSession, heading + otherSession + loadingSession]) {
        await withPage(initial, async page => {
            await page.evaluate(
                html => {
                    setTimeout(() => {
                        document.body.innerHTML = html;
                        document.body.dataset.phase = "complete";
                    }, 250);
                },
                heading + otherSession + session,
            );
            const started = performance.now();
            const result = await selectTicketPlusSession(page, settings, options);
            assert(performance.now() - started >= 200);
            assert.equal(result.sessionId, "session-A");
            assert.deepEqual(await clicks(page), ["complete:立即購買"]);
        });
    }
});

test("活動等待：跨流程內容仍立即停止", async () => {
    const cases = [
        heading + loadingSession + '<div role="dialog">PRIVATE_DIALOG</div>',
        heading + loadingSession + '<label>姓名<input value="PRIVATE_CONTACT"></label>',
        heading + loadingSession + "<button>下一步</button>",
        heading + loadingSession + "<button>前往付款</button>",
        heading + loadingSession + '<div class="stepText checkedStep">付款結帳</div>',
    ];
    for (const html of cases) await withPage(html, expectBlocked);
});

test("活動佔位：人工取消及全程期限均停止，不等待活動期限", async () => {
    for (const manual of [true, false]) {
        await withPage(heading + loadingSession, async page => {
            const abort = new AbortController();
            let now = 0;
            const control = new TicketPlusRunControl(abort.signal, () => now);
            control.startDeadline(1);
            const pending = selectTicketPlusSession(page, settings, options, control);
            const stopped = assert.rejects(pending, error => {
                assert(error instanceof TicketPlusStopError);
                assert.equal(error.stopReason, manual ? "user-stop" : "time-limit");
                return true;
            });
            await delay(100);
            if (manual) abort.abort();
            else now = 60_001;
            await stopped;
            assert.deepEqual(await clicks(page), []);
        });
    }
});

test("活動佔位：空白與佔位反覆切換不延長期限", { timeout: 8_000 }, async () => {
    await withPage(heading + loadingSession, async page => {
        // 頁面自行重繪，等待策略不能因內容改變而重設期限。
        await page.evaluate(html => {
            let showPlaceholder = false;
            setInterval(() => {
                document.body.innerHTML = showPlaceholder ? html : "<main>載入中</main>";
                showPlaceholder = !showPlaceholder;
            }, 70);
        }, heading + loadingSession);
        const started = performance.now();
        await assert.rejects(
            selectTicketPlusSession(page, settings, { ...options, activityReadyTimeoutMs: 400 }),
            error => {
                assert(error instanceof TicketPlusSessionError);
                assert.equal(error.stage, "before-click");
                assert(["activity-ready-timeout", "read-failed"].includes(error.reason));
                if (error.diagnostic?.check !== "page-state") assert.fail();
                assert.equal(error.diagnostic.snapshot.readFailure, undefined);
                assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
                assert(error.diagnostic.activityWait!.observations > 1);
                return true;
            },
        );
        const elapsed = performance.now() - started;
        assert(elapsed >= 390 && elapsed < 1500);
        assert.deepEqual(await clicks(page), []);
    });
});
