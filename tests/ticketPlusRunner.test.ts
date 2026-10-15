import { waitForTicketPlusWorkerLogin } from "../src/local/ticketPlusWorkerLogin.js";
import { ticketPlusResultMessage } from "../src/cli/ticketPlus.js";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { runTicketPlus } from "../src/app/runTicketPlus.js";
import { acquirePurchaseLease, purchaseOccupied } from "../src/app/purchaseLock.js";
import type { TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";
import { activity } from "./fixtures/ticketplus/pages.js";
import { readyInformation, readyOrder, failureDialog } from "./fixtures/ticketplus/submissionPage.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
};
async function setup(context: BrowserContext, rejected: boolean) {
    // 模擬 persistent context 啟動時已有的初始分頁。
    await context.newPage();
    const requests: string[] = [];
    await context.route("**/*", route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: path.startsWith("/activity/")
                ? activity
                : path.startsWith("/confirm/")
                  ? readyInformation
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
                if (button.dataset.fixture === "dismiss") {
                    recorder.record("dismiss");
                    document.querySelector(".v-dialog__content")!.remove();
                    return;
                }
                if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        recorder.record("information");
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
            let logins = 0;
            const result = await runTicketPlus(settings, {
                lease,
                webdriverExperiment: rejected,
                waitForLogin: async page => {
                    logins++;
                    assert.equal(page.url(), settings.eventUrl);
                },
            });
            assert.equal(result.outcome, rejected ? "rejected" : "information-ready");
            assert.equal(logins, 1);
            const counts = await context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("counts")!));
            assert.deepEqual(counts, {
                session: 1,
                plus: 2,
                submit: 1,
                dismiss: rejected ? 1 : 0,
                information: 0,
                other: 0,
            });
            assert.equal(context.pages()[0]!.isClosed(), false);
            assert(purchaseOccupied(directory));
            assert.throws(() => acquirePurchaseLease(directory), /占用/);
            assert.deepEqual(requests, [
                "/activity/event-fixture",
                "/order/event-fixture/session-B",
                ...(rejected ? [] : ["/confirm/event-fixture/session-B"]),
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
        await assert.rejects(
            runTicketPlus({ ...settings, platform: "klook" } as never, { waitForLogin: async () => {} }),
        );
        assert.equal(launch.mock.callCount(), 0);
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            waitForLogin: async () => {},
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
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(dir),
            waitForLogin: async () => {
                throw new Error("cancel");
            },
        });
        assert.equal(result.outcome, "stopped");
        assert.deepEqual(requests, ["/activity/event-fixture"]);
        assert(purchaseOccupied(dir));
        await context.close();
        assert(!purchaseOccupied(dir));
    } finally {
        started.mock.restore();
        await browser.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus runner：瀏覽器先關閉也等流程結束才解鎖", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-close-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
        resume = resolve;
    });
    const login = new Promise<void>(resolve => {
        entered = resolve;
    });
    try {
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(dir),
            waitForLogin: async () => {
                entered();
                await gate;
            },
        });
        await login;
        await context.close();
        assert(purchaseOccupied(dir));
        resume();
        assert.equal((await pending).outcome, "stopped");
        assert(!purchaseOccupied(dir));
    } finally {
        resume();
        launch.mock.restore();
        await browser.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus runner：活動不符保留具體原因，CLI 指出設定欄位且不點擊", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-mismatch-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests = await setup(context, false);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(
            { ...settings, eventName: "不同活動" },
            {
                lease: acquirePurchaseLease(dir),
                waitForLogin: async () => {},
            },
        );
        assert.equal(result.outcome, "stopped");
        assert("sessionFailure" in result);
        assert.deepEqual(result.sessionFailure, { reason: "activity-mismatch", stage: "before-click" });
        assert.match(ticketPlusResultMessage(result), /eventName 與 eventUrl/);
        assert.match(ticketPlusResultMessage(result), /尚未嘗試點擊立即購買/);
        assert.deepEqual(requests, ["/activity/event-fixture"]);
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
        const stopped = await runTicketPlus(settings, { signal: pre.signal, waitForLogin: async () => {} });
        assert.equal(stopped.stopReason, "user-stop");
        assert.equal(launch.mock.callCount(), 0);
        const lease = acquirePurchaseLease(directory);
        const controller = new AbortController();
        let settled = false;
        let managed = false;
        let logins = 0;
        const pending = runTicketPlus(settings, {
            lease,
            signal: controller.signal,
            onBrowser: () => {
                managed = true;
            },
            waitForLogin: async () => {
                logins++;
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
        assert.equal(logins, 0);
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
            waitForLogin: (page, signal) => waitForTicketPlusWorkerLogin(page, () => controller.abort(), signal),
        });
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "user-stop");
        assert.match(ticketPlusResultMessage(result), /已依要求停止/);
        assert.deepEqual(requests, ["/activity/event-fixture"]);
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
                waitForLogin: async () => {},
            }),
            /購票占用識別無法確認/,
        );
        assert(purchaseOccupied(directory));
        const result = await runTicketPlus(settings, {
            lease,
            signal: controller.signal,
            waitForLogin: async () => {},
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
            waitForLogin: async () => {},
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
            waitForLogin: async () => {},
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
        assert.deepEqual(requests, ["/activity/event-fixture", "/order/event-fixture/session-B"]);
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});
