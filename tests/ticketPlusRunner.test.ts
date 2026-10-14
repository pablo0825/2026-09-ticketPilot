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
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
async function setup(context: BrowserContext, rejected: boolean) {
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
