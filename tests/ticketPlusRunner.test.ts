import { ticketPlusEventMessage } from "../src/app/ticketPlusPresentation.js";
import { loggedInHome, loggedOutHome } from "./fixtures/ticketplus/loginPage.js";
import { ticketPlusResultDiagnostic, ticketPlusResultMessage } from "../src/app/ticketPlusPresentation.js";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { runTicketPlus } from "../src/app/runTicketPlus.js";
import { acquirePurchaseLease, purchaseOccupied } from "../src/storage/purchaseLock.js";
import type { TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";
import { activity, checkout } from "./fixtures/ticketplus/pages.js";
import { readyInformation, readyOrder, failureDialog } from "./fixtures/ticketplus/submissionPage.js";
import { noticeDialog, noticeTitles } from "./fixtures/ticketplus/activityNotice.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
};
async function setup(context: BrowserContext, rejected: boolean, activityHtml = activity) {
    // 模擬 persistent context 啟動時已有的初始分頁。
    await context.newPage();
    const requests: string[] = [];
    await context.route("**/*", route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body:
                path === "/"
                    ? loggedInHome
                    : path.startsWith("/activity/")
                      ? activityHtml
                      : path.startsWith("/confirm/")
                        ? readyInformation
                        : path.startsWith("/checkout/")
                          ? checkout
                          : readyOrder.replace("<div>2</div>", "<div>0</div>"),
        });
    });
    await context.addInitScript(
        ({ rejected, dialog }) => {
            const saved = sessionStorage.getItem("counts");
            const counts: Record<string, number> = saved
                ? JSON.parse(saved)
                : { session: 0, plus: 0, submit: 0, dismiss: 0, information: 0, other: 0 };
            const recorder = {
                record(key: string) {
                    counts[key] = (counts[key] ?? 0) + 1;
                    sessionStorage.setItem("counts", JSON.stringify(counts));
                },
            };
            // 固定頁面行為與目的地，不依正式 runner 設定產生結果。
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent === "立即購買") {
                    recorder.record("session");
                    location.assign("/order/event-fixture/session-B");
                    return;
                }
                if (button.querySelector(".mdi-plus")) {
                    recorder.record("plus");
                    const value = button.parentElement!.querySelector("div")!;
                    value.textContent = String(Number(value.textContent) + 1);
                    return;
                }
                if (button.dataset.notice === "ok") {
                    recorder.record("notice");
                    button.closest(".v-dialog__content")!.remove();
                    return;
                }
                if (button.dataset.fixture === "dismiss") {
                    recorder.record("dismiss");
                    document.querySelector(".v-dialog__content")!.remove();
                    return;
                }
                if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        // 資料頁下一步比照實站轉到付款頁
                        recorder.record("information");
                        location.assign("/checkout/event-fixture/session-B");
                        return;
                    }
                    recorder.record("submit");
                    if (rejected) document.body.insertAdjacentHTML("beforeend", dialog);
                    else location.assign("/confirm/event-fixture/session-B");
                    return;
                }
                recorder.record("other");
            });
        },
        { rejected, dialog: failureDialog() },
    );
    return requests;
}

test("TicketPlus runner：真實本機頁面串接到資料頁／失敗停止，保留瀏覽器與占用", { timeout: 20_000 }, async () => {
    for (const rejected of [false, true]) {
        const directory = await mkdtemp(join(tmpdir(), "ticketplus-runner-"));
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const requests = await setup(context, rejected);
        const launch = mock.method(chromium, "launchPersistentContext", async () => context);
        try {
            const lease = acquirePurchaseLease(directory);
            const result = await runTicketPlus(settings, {
                lease,
                webdriverExperiment: rejected,
            });
            assert.equal(result.outcome, rejected ? "rejected" : "payment-ready");
            const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
            assert.deepEqual(counts, {
                session: 1,
                plus: 2,
                submit: 1,
                dismiss: rejected ? 1 : 0,
                information: rejected ? 0 : 1,
                other: 0,
            });
            assert.equal(context.pages()[0]!.isClosed(), false);
            assert(purchaseOccupied(directory));
            assert.throws(() => acquirePurchaseLease(directory), /占用/);
            assert.deepEqual(requests, [
                "/",
                "/activity/event-fixture",
                "/order/event-fixture/session-B",
                ...(rejected ? [] : ["/confirm/event-fixture/session-B", "/checkout/event-fixture/session-B"]),
            ]);
            const args = launch.mock.calls[0]!.arguments;
            assert(String(args[0]).endsWith("browser-profile-ticketplus"));
            assert.deepEqual(args[1]?.args, rejected ? ["--disable-blink-features=AutomationControlled"] : []);
            assert.equal(args[1]?.headless, false);
            assert.equal(args[1]?.channel, "chrome");
            await context.close();
            assert.equal(purchaseOccupied(directory), false);
        } finally {
            launch.mock.restore();
            await browser.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
});

test("TicketPlus runner：啟動失敗釋放占用，錯設定不啟動；登入取消不選票", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-start-"));
    const launch = mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("PRIVATE_STARTUP");
    });
    try {
        await assert.rejects(runTicketPlus({ ...settings, platform: "klook" } as never, {}));
        assert.equal(launch.mock.callCount(), 0);
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
        });
        assert.equal(result.outcome, "stopped");
        assert(!JSON.stringify(result).includes("PRIVATE_STARTUP"));
        assert.equal(purchaseOccupied(directory), false);
    } finally {
        launch.mock.restore();
        await rm(directory, { recursive: true, force: true });
    }

    const dir = await mkdtemp(join(tmpdir(), "ticketplus-cancel-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    const started = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const controller = new AbortController();
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(dir),
            signal: controller.signal,
            onEvent: event => {
                if (event.type === "stage" && event.stage === "checking-login") controller.abort();
            },
        });
        assert.equal(result.outcome, "stopped");
        assert.deepEqual(requests, ["/"]);
        assert(purchaseOccupied(dir));
        await context.close();
        assert(!purchaseOccupied(dir));
    } finally {
        started.mock.restore();
        await browser.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus runner：登入等待時關閉瀏覽器，流程停止後解除占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-close-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    await context.route("https://ticketplus.com.tw/", route =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedOutHome }),
    );
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {
        entered = resolve;
    });
    try {
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(dir),
            onEvent: event => {
                if (event.type === "stage" && event.stage === "waiting-for-login") entered();
            },
        });
        await waiting;
        assert(purchaseOccupied(dir));
        await context.close();
        assert.equal((await pending).outcome, "stopped");
        assert(!purchaseOccupied(dir));
        assert.equal(requests.length, 0);
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus runner：目標日期不符保留具體原因且不點擊", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-mismatch-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(
            { ...settings, targets: [{ ...settings.targets[0]!, date: "2026-10-31" }] },
            {
                lease: acquirePurchaseLease(dir),
            },
        );
        assert.equal(result.outcome, "stopped");
        assert("sessionFailure" in result);
        assert.equal(result.sessionFailure?.reason, "session-date-mismatch");
        assert.equal(result.sessionFailure?.stage, "before-click");
        assert.equal(result.sessionFailure?.diagnostic?.check, "page-state");
        assert.match(ticketPlusResultDiagnostic(result) ?? "", /"pageKind":"activity"/);
        assert.doesNotMatch(ticketPlusResultMessage(result), /"pageKind"/);
        assert.match(ticketPlusResultMessage(result), /目標場次日期與設定不符/);
        assert.match(ticketPlusResultMessage(result), /尚未嘗試點擊場次按鈕/);
        assert.deepEqual(requests, ["/", "/activity/event-fixture"]);
        assert.equal(await context.pages()[0]!.evaluate(() => sessionStorage.getItem("counts")), null);
        assert(purchaseOccupied(dir));
        await context.close();
        assert(!purchaseOccupied(dir));
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus runner：預先取消不啟動；啟動途中取消須接管瀏覽器與占用", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-stop-start-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    let releaseLaunch!: () => void;
    let enteredLaunch!: () => void;
    const gate = new Promise<void>(resolve => {
        releaseLaunch = resolve;
    });
    const entered = new Promise<void>(resolve => {
        enteredLaunch = resolve;
    });
    const launch = mock.method(chromium, "launchPersistentContext", async () => {
        enteredLaunch();
        await gate;
        return context;
    });
    try {
        const pre = new AbortController();
        pre.abort();
        const stopped = await runTicketPlus(settings, { signal: pre.signal });
        assert.equal(stopped.stopReason, "user-stop");
        assert.equal(launch.mock.callCount(), 0);
        const lease = acquirePurchaseLease(directory);
        const controller = new AbortController();
        let settled = false;
        let managed = false;
        let loginChecks = 0;
        const pending = runTicketPlus(settings, {
            lease,
            signal: controller.signal,
            onBrowser: () => {
                managed = true;
            },
            onEvent: event => {
                if (event.type === "stage" && event.stage === "checking-login") loginChecks++;
            },
        }).then(result => {
            settled = true;
            return result;
        });
        await entered;
        controller.abort();
        assert.equal(settled, false);
        assert(purchaseOccupied(directory));
        releaseLaunch();
        assert.equal((await pending).stopReason, "user-stop");
        assert.equal(managed, true);
        assert.equal(loginChecks, 0);
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        releaseLaunch();
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：登入等待取消保留畫面與占用，不選場次", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-stop-login-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    const controller = new AbortController();
    try {
        const lease = acquirePurchaseLease(directory);
        const result = await runTicketPlus(settings, {
            lease,
            signal: controller.signal,
            onEvent: event => {
                if (event.type === "stage" && event.stage === "checking-login") controller.abort();
            },
        });
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "user-stop");
        assert.match(ticketPlusResultMessage(result), /已依要求停止/);
        assert.deepEqual(requests, ["/"]);
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：預先取消接管有效外部占用，不釋放錯誤識別的占用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-prestop-lease-"));
    const launch = mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("不可啟動");
    });
    const controller = new AbortController();
    controller.abort();
    try {
        const lease = acquirePurchaseLease(directory);
        await assert.rejects(
            runTicketPlus(settings, {
                lease: { ...lease, token: "wrong-token" },
                signal: controller.signal,
            }),
            /購票占用識別無法確認/,
        );
        assert(purchaseOccupied(directory));
        const result = await runTicketPlus(settings, {
            lease,
            signal: controller.signal,
        });
        assert.equal(result.stopReason, "user-stop");
        assert.equal(result.progress.submitAttempted, false);
        assert(!purchaseOccupied(directory));
        assert.equal(launch.mock.callCount(), 0);
    } finally {
        launch.mock.restore();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：初始分頁遺失不重新建立，保留瀏覽器直到人工關閉", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-no-page-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    const newPage = mock.method(context, "newPage", async () => {
        throw new Error("不可重新建立分頁");
    });
    try {
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
        });
        assert.equal(result.outcome, "stopped");
        assert.equal(newPage.mock.callCount(), 0);
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        launch.mock.restore();
        newPage.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：首張加票後取消，停止訊號穿過順位與張數層且不提交", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-stop-quantity-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    const controller = new AbortController();
    let clicked!: () => void;
    const firstClick = new Promise<void>(resolve => {
        clicked = resolve;
    });
    await context.exposeBinding("fixtureFirstPlus", () => {
        clicked();
    });
    await context.addInitScript(() => {
        // 攔下第一個加票的更新，用獨立DOM計數記錄，稍後由測試釋放。
        document.addEventListener(
            "click",
            event => {
                const button = (event.target as Element).closest("button");
                if (!button?.querySelector(".mdi-plus")) return;
                event.stopImmediatePropagation();
                (window as any).fixturePlus = ((window as any).fixturePlus ?? 0) + 1;
                (window as any).fixtureAcknowledge = () => {
                    button.parentElement!.querySelector("div")!.textContent = "1";
                };
                void (window as any).fixtureFirstPlus();
            },
            true,
        );
    });
    try {
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            signal: controller.signal,
        });
        await firstClick;
        controller.abort();
        const result = await pending;
        assert.equal(result.stopReason, "user-stop");
        assert.equal(result.progress.submitAttempted, false);
        const page = context.pages()[0]!;
        await page.evaluate(() => (window as any).fixtureAcknowledge());
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(await page.evaluate(() => (window as any).fixturePlus), 1);
        const counts = await page.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
        assert.equal(counts.session, 1);
        assert.equal(counts.submit, 0);
        assert.deepEqual(requests, ["/", "/activity/event-fixture", "/order/event-fixture/session-B"]);
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：外部登入狀態到達前不導航或購票，確認後只開一次活動", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-login-gate-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    await context.route("https://ticketplus.com.tw/", route =>
        route.fulfill({
            contentType: "text/html; charset=utf-8",
            body:
                loggedOutHome +
                '<script>fetch("/fixture-member").then(r => r.text()).then(html => { document.querySelector("header").outerHTML = html; });</script>',
        }),
    );
    await context.route("**/fixture-member", async route => {
        await gate;
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedInHome });
    });
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => {
        entered = resolve;
    });
    try {
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            onEvent: event => {
                if (event.type === "stage" && event.stage === "waiting-for-login") entered();
            },
        });
        await waiting;
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.equal(requests.length, 0);
        assert.equal(await context.pages()[0]!.evaluate(() => sessionStorage.getItem("counts")), null);
        release();
        assert.equal((await pending).outcome, "payment-ready");
        assert.equal(requests.filter(path => path.startsWith("/activity/")).length, 1);
        const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
        assert.equal(counts.session, 1);
        assert.equal(counts.plus, 2);
        assert.equal(counts.submit, 1);
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        release();
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：前往活動前取消不導航，活動登入失效不選場次", { timeout: 15_000 }, async () => {
    for (const mode of ["cancel-before-navigation", "logged-out-at-activity"] as const) {
        const directory = await mkdtemp(join(tmpdir(), "ticketplus-login-boundary-"));
        const browser = await chromium.launch();
        const context = await browser.newContext();
        const requests = await setup(context, false);
        if (mode === "logged-out-at-activity") {
            await context.route("**/activity/**", route => {
                requests.push(new URL(route.request().url()).pathname);
                return route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedOutHome + activity });
            });
        }
        const launch = mock.method(chromium, "launchPersistentContext", async () => context);
        const controller = new AbortController();
        try {
            const result = await runTicketPlus(settings, {
                lease: acquirePurchaseLease(directory),
                signal: controller.signal,
                onEvent: event => {
                    if (
                        mode === "cancel-before-navigation" &&
                        event.type === "stage" &&
                        event.stage === "opening-activity"
                    )
                        controller.abort();
                },
            });
            assert.equal(result.outcome, "stopped");
            assert.equal(result.progress.submitAttempted, false);
            assert.deepEqual(requests, mode === "cancel-before-navigation" ? ["/"] : ["/", "/activity/event-fixture"]);
            assert.equal(await context.pages()[0]!.evaluate(() => sessionStorage.getItem("counts")), null);
            if (mode === "cancel-before-navigation") assert.equal(result.stopReason, "user-stop");
            else {
                assert.equal(result.reason, "startup-stopped");
                assert.equal("activityLoginFailure" in result && result.activityLoginFailure, "unconfirmed");
                assert.match(ticketPlusResultMessage(result), /開啟活動頁後無法確認登入狀態/);
            }
            assert(purchaseOccupied(directory));
            await context.close();
            assert(!purchaseOccupied(directory));
        } finally {
            launch.mock.restore();
            await browser.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
});

test("登入診斷：同狀態不洗版，欄位變化與人工停止保留最後快照且零購票", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-login-diagnostic-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    await context.route("https://ticketplus.com.tw/", route =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedOutHome }),
    );
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    const controller = new AbortController();
    const events: import("../src/app/runTicketPlus.js").TicketPlusRunEvent[] = [];
    let firstSeen = () => {};
    let changedSeen = () => {};
    const first = new Promise<void>(resolve => {
        firstSeen = resolve;
    });
    const changed = new Promise<void>(resolve => {
        changedSeen = resolve;
    });
    try {
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            signal: controller.signal,
            onEvent: event => {
                events.push(structuredClone(event));
                if (event.type !== "login-observation") return;
                if (event.summary.lastObservation?.markers.dialogs === 1) changedSeen();
                else firstSeen();
                // 外部通知即使修改收到的副本，也不能讓正式辨識通過。
                if (event.summary.lastObservation) event.summary.lastObservation.state = "logged-in";
            },
        });
        await first;
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.equal(events.filter(event => event.type === "login-observation").length, 1);
        assert.equal(requests.length, 0);
        const page = context.pages()[0]!;
        await page.evaluate(() =>
            document.body.insertAdjacentHTML(
                "beforeend",
                '<div role="dialog">PRIVATE_DIALOG<input value="PRIVATE_PASSWORD"></div>',
            ),
        );
        await changed;
        controller.abort();
        const result = await pending;
        assert.equal(result.stopReason, "user-stop");
        assert.equal(result.progress.submitAttempted, false);
        assert.equal(result.loginDiagnostic?.lastObservation?.markers.dialogs, 1);
        assert.equal(result.loginDiagnostic?.lastObservation?.routeKind, "home");
        assert((result.loginDiagnostic?.observations ?? 0) >= 3);
        assert((result.loginDiagnostic?.elapsedMs ?? 0) >= 600);
        assert.equal(events.filter(event => event.type === "login-stopped").length, 1);
        assert.equal(requests.length, 0);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("counts")), null);
        assert.match(ticketPlusResultMessage(result), /已依要求停止/);
        assert.doesNotMatch(ticketPlusResultMessage(result), /登入停止診斷/);
        assert.match(ticketPlusResultDiagnostic(result) ?? "", /登入停止診斷/);
        const logs = events.map(ticketPlusEventMessage).filter(Boolean).join("\n");
        assert.match(logs, /登入狀態觀測變化/);
        assert.match(logs, /登入等待停止/);
        assert.doesNotMatch(JSON.stringify({ events, result, logs }), /PRIVATE_DIALOG|PRIVATE_PASSWORD|0987/);
    } finally {
        controller.abort();
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：活動頁有入場規定提醒時先按確定一次，再照常選場次到資料頁", { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-runner-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await setup(context, false, activity + noticeDialog(noticeTitles.entry));
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(settings, { lease: acquirePurchaseLease(directory) });
        assert.equal(result.outcome, "payment-ready");
        const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
        assert.equal(counts.notice, 1);
        assert.equal(counts.session, 1);
        assert.equal(counts.other, 0);
        await context.close();
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test(
    "TicketPlus runner：活動頁是未知彈窗時不當成提醒處理，按確定無效的提醒則回報無法關閉",
    { timeout: 30_000 },
    async () => {
        const stuck = activity + noticeDialog(noticeTitles.entry).replace('data-notice="ok"', 'data-notice="stuck"');
        for (const [html, noticeFailure] of [
            [activity + '<div role="dialog">未知提示</div>', undefined],
            [stuck, "notice-dismiss-failed"],
        ] as const) {
            const directory = await mkdtemp(join(tmpdir(), "ticketplus-runner-"));
            const browser = await chromium.launch();
            const context = await browser.newContext();
            await setup(context, false, html);
            const launch = mock.method(chromium, "launchPersistentContext", async () => context);
            try {
                const result = await runTicketPlus(settings, { lease: acquirePurchaseLease(directory) });
                assert.equal(result.outcome, "stopped");
                assert.equal("noticeFailure" in result ? result.noticeFailure : undefined, noticeFailure);
                const counts = await context
                    .pages()[0]!
                    .evaluate(() => JSON.parse(sessionStorage.getItem("counts") ?? "{}"));
                assert.equal(counts.session ?? 0, 0);
                await context.close();
            } finally {
                launch.mock.restore();
                await browser.close();
                await rm(directory, { recursive: true, force: true });
            }
        }
    },
);

test("TicketPlus runner：開啟活動頁已關過提醒，同一次載入又出現時選場次不再點", { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-runner-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    // 開頁即有提醒；關閉 700ms 後同一次載入重現，場次列 1.5 秒後才畫出
    const late = `<script>
        document.addEventListener("click", event => {
            const button = event.target.closest('[data-notice="ok"]');
            if (!button) return;
            const html = button.closest(".v-dialog__content").outerHTML;
            setTimeout(() => document.body.insertAdjacentHTML("beforeend", html), 700);
        }, true);
    </script>`;
    const rows = activity.slice(activity.indexOf('<div class="sesstion-item'));
    const html =
        activity.slice(0, activity.indexOf('<div class="sesstion-item')) +
        noticeDialog(noticeTitles.entry) +
        late +
        `<script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(rows)}), 1500);</script>`;
    await setup(context, false, html);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(settings, { lease: acquirePurchaseLease(directory) });
        assert.equal(result.outcome, "stopped");
        assert.equal("sessionFailure" in result ? result.sessionFailure?.reason : undefined, "notice-dismiss-failed");
        const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
        assert.equal(counts.notice, 1);
        assert.equal(counts.session ?? 0, 0);
        await context.close();
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus runner：抽選設定遇到購票活動頁，在點擊場次前回報流程類型不符", { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-runner-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(
            { ...settings, flowType: "lottery" },
            { lease: acquirePurchaseLease(directory) },
        );
        assert.equal(result.outcome, "stopped");
        assert.equal("sessionFailure" in result ? result.sessionFailure?.reason : undefined, "flow-mismatch");
        const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts") ?? "{}"));
        assert.equal(counts.session ?? 0, 0);
        await context.close();
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});
