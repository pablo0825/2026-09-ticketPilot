import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { runTicketPlus } from "../src/app/flows/ticketplus/runTicketPlus.js";
import type { TicketPlusRunEvent } from "../src/app/flows/ticketplus/runTicketPlus.js";
import { acquirePurchaseLease } from "../src/storage/purchaseLock.js";
import type { TicketPlusActivitySettings } from "../src/config/platforms/ticketplus/activitySettings.js";
import { loggedInHome } from "./fixtures/ticketplus/loginPage.js";
import { activity } from "./fixtures/ticketplus/pages.js";
import { readyOrder } from "./fixtures/ticketplus/submissionPage.js";
import { lotteryInputPage, registerPage } from "./fixtures/ticketplus/lotteryPages.js";

// 抽選：活動頁「立即登記」→ 選票 → 輸入資料頁（參加者已填）→ 確認登記頁。
const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    flowType: "lottery",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
};

async function setup(context: BrowserContext) {
    await context.newPage();
    await context.route("**/*", route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body:
                path === "/"
                    ? loggedInHome
                    : path.startsWith("/activity/")
                      ? activity.replaceAll("立即購買", "立即登記")
                      : path.startsWith("/confirm/")
                        ? lotteryInputPage({ rows: ["filled", "filled"] })
                        : path.startsWith("/checkout/")
                          ? registerPage
                          : path.startsWith("/order/")
                            ? readyOrder.replace("<div>2</div>", "<div>0</div>")
                            : "<html><body>其他頁面</body></html>",
        });
    });
    await context.addInitScript(() => {
        // 只用物件方法，避免 tsx 在序列化函式中加入瀏覽器沒有的 __name。
        const store = {
            bump(key: string) {
                sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
            },
        };
        document.addEventListener("click", event => {
            const target = event.target as Element;
            const lottery = target.closest<HTMLElement>("[data-lottery]");
            if (lottery) {
                store.bump("lottery-" + lottery.dataset.lottery);
                if (lottery.dataset.lottery === "terms") {
                    const input = document.getElementById("terms") as HTMLInputElement;
                    input.checked = !input.checked;
                    document.querySelector<HTMLButtonElement>('[data-lottery="next"]')!.disabled = !input.checked;
                }
                if (lottery.dataset.lottery === "next") location.assign("/checkout/event-fixture/session-B");
                return;
            }
            const button = target.closest("button");
            if (!button) return;
            if (button.textContent?.trim() === "立即登記") location.assign("/order/event-fixture/session-B");
            else if (button.querySelector(".mdi-plus")) {
                const value = button.parentElement!.querySelector("div")!;
                value.textContent = String(Number(value.textContent) + 1);
            } else if (button.textContent?.trim() === "下一步" && location.pathname.startsWith("/order/")) {
                store.bump("submit");
                location.assign("/confirm/event-fixture/session-B");
            }
        });
    });
}

async function withRun(work: (context: BrowserContext, directory: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-lottery-runner-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await setup(context);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        await work(context, directory);
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
}

async function counts(context: BrowserContext) {
    return context
        .pages()[0]!
        .evaluate(() =>
            Object.fromEntries(
                ["submit", "lottery-terms", "lottery-next", "lottery-register", "lottery-cancel"].map(key => [
                    key,
                    Number(sessionStorage.getItem(key) ?? "0"),
                ]),
            ),
        );
}

test("抽選 runner：到輸入資料頁後等待確認，確認後勾條款按下一步，停在確認登記前", { timeout: 30_000 }, async () => {
    await withRun(async (context, directory) => {
        const events: TicketPlusRunEvent[] = [];
        let confirmations = 0;
        let before: Record<string, number> | undefined;
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            onEvent: event => {
                events.push(event);
            },
            waitForParticipants: async confirmationId => {
                assert.match(confirmationId, /^[0-9a-f-]{36}$/);
                confirmations++;
                await new Promise(resolve => setTimeout(resolve, 300));
                before = await counts(context);
            },
        });
        assert.equal(result.outcome, "registration-ready", JSON.stringify(result));
        assert.equal(confirmations, 1);
        // 確認前零點擊；確認後條款與下一步各一次，從不按確認登記或取消登記
        assert.deepEqual(before, {
            submit: 1,
            "lottery-terms": 0,
            "lottery-next": 0,
            "lottery-register": 0,
            "lottery-cancel": 0,
        });
        assert.deepEqual(await counts(context), {
            submit: 1,
            "lottery-terms": 1,
            "lottery-next": 1,
            "lottery-register": 0,
            "lottery-cancel": 0,
        });
        assert(events.some(event => event.type === "participants-wait"));
        assert(events.some(event => event.type === "stage" && event.stage === "waiting-for-participants"));
        await context.close();
    });
});

test("抽選 runner：等待中使用者停止或頁面離開輸入資料頁，停止且不勾條款", { timeout: 40_000 }, async () => {
    for (const mode of ["user-stop", "page-changed"] as const) {
        await withRun(async (context, directory) => {
            const abort = new AbortController();
            const result = await runTicketPlus(settings, {
                lease: acquirePurchaseLease(directory),
                signal: abort.signal,
                waitForParticipants: async () => {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    if (mode === "user-stop") abort.abort();
                    else await context.pages()[0]!.goto("https://ticketplus.com.tw/activity/event-fixture");
                    await new Promise(() => {});
                },
            });
            assert.equal(result.outcome, "stopped");
            if (mode === "page-changed") {
                assert.equal(
                    "lotteryFailure" in result ? result.lotteryFailure : undefined,
                    "participant-page-changed",
                );
            } else {
                assert.equal(result.stopReason, "user-stop");
            }
            const after = await counts(context);
            assert.equal(after["lottery-terms"], 0);
            assert.equal(after["lottery-next"], 0);
            await context.close();
        });
    }
});

test("抽選 runner：等待填寫超過最長執行時間仍繼續等待，確認後照常完成", { timeout: 30_000 }, async () => {
    await withRun(async (context, directory) => {
        let now = 0;
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            deadlineNow: () => now,
            waitForParticipants: async () => {
                now += 60 * 60_000;
                await new Promise(resolve => setTimeout(resolve, 1_500));
            },
        });
        assert.equal(result.outcome, "registration-ready");
        await context.close();
    });
});

test("抽選 runner：確認通道失敗或購票頁被關閉，停止且不勾條款", { timeout: 40_000 }, async () => {
    for (const mode of ["rejected", "page-closed"] as const) {
        await withRun(async (context, directory) => {
            const page = context.pages()[0]!;
            const result = await runTicketPlus(settings, {
                lease: acquirePurchaseLease(directory),
                waitForParticipants: async () => {
                    await new Promise(resolve => setTimeout(resolve, 200));
                    if (mode === "rejected") throw new Error("確認通道中斷");
                    await page.close();
                    await new Promise(() => {});
                },
            });
            assert.equal(result.outcome, "stopped", JSON.stringify(result));
            assert.equal(
                "lotteryFailure" in result ? result.lotteryFailure : undefined,
                mode === "rejected" ? "confirmation-failed" : "participant-page-changed",
            );
            if (mode === "rejected") {
                const after = await counts(context);
                assert.equal(after["lottery-terms"], 0);
                assert.equal(after["lottery-next"], 0);
            }
            await context.close();
        });
    }
});

test("抽選 runner：到輸入資料頁時全程期限幾乎用完，確認後的收尾仍不受期限影響", { timeout: 30_000 }, async () => {
    await withRun(async (context, directory) => {
        // 真實時間加偏移：全程期限在「選場次」階段開始，抵達輸入資料頁時把剩餘時間調成 50ms
        let offset = 0;
        let startedAt = 0;
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(directory),
            deadlineNow: () => performance.now() + offset,
            onEvent: event => {
                if (event.type === "stage" && event.stage === "selecting-session") startedAt = performance.now();
                if (event.type === "participants-wait") offset = startedAt + 10 * 60_000 - 50 - performance.now();
            },
            waitForParticipants: async () => {
                await new Promise(resolve => setTimeout(resolve, 300));
            },
        });
        assert.equal(result.outcome, "registration-ready", JSON.stringify(result));
        const after = await counts(context);
        assert.equal(after["lottery-terms"], 1);
        assert.equal(after["lottery-next"], 1);
        await context.close();
    });
});
