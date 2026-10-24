import { loggedInHome, loggedOutHome } from "./fixtures/ticketplus/loginPage.js";
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
import { readyInformation, readyOrder, failureDialog, queueDialog } from "./fixtures/ticketplus/submissionPage.js";
import { activity, checkout } from "./fixtures/ticketplus/pages.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
    maxRunMinutes: 10,
};
type Mode = "direct" | "queue" | "failure";

async function install(context: BrowserContext, mode: Mode, requests: string[]) {
    // 保留真實 DOM 點擊，只有網站內容與外部瀏覽器啟動由本機替代。
    await context.newPage();
    await context.route("**/*", route => {
        requests.push(route.request().url());
        return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: new URL(route.request().url()).pathname === "/" ? loggedInHome : activity,
        });
    });
    await context.addInitScript(
        ({ mode, order, information, checkout, queue, failure }) => {
            const counts = { session: 0, plus: 0, submit: 0, dismiss: 0, other: 0 };
            sessionStorage.setItem("deadlineCounts", JSON.stringify(counts));
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent === "立即購買") {
                    counts.session++;
                    history.replaceState({}, "", "/order/event-fixture/session-B");
                    document.body.innerHTML = order;
                } else if (button.querySelector(".mdi-plus")) {
                    counts.plus++;
                    const quantity = button.parentElement!.querySelector("div")!;
                    quantity.textContent = String(Number(quantity.textContent) + 1);
                } else if (button.dataset.fixture === "dismiss") {
                    counts.dismiss++;
                    document.querySelector(".v-dialog__content")!.remove();
                } else if (button.textContent === "下一步" && location.pathname.startsWith("/confirm/")) {
                    // 資料頁下一步比照實站轉到付款頁
                    history.replaceState({}, "", "/checkout/event-fixture/session-B");
                    document.body.innerHTML = checkout;
                } else if (button.textContent === "下一步" && location.pathname.startsWith("/order/")) {
                    counts.submit++;
                    if (mode === "direct") {
                        history.replaceState({}, "", "/confirm/event-fixture/session-B");
                        document.body.innerHTML = information;
                    } else document.body.insertAdjacentHTML("beforeend", mode === "queue" ? queue : failure);
                } else counts.other++;
                sessionStorage.setItem("deadlineCounts", JSON.stringify(counts));
            });
        },
        {
            mode,
            order: readyOrder.replace("<div>2</div>", "<div>0</div>"),
            information: readyInformation,
            checkout,
            queue: queueDialog,
            failure: failureDialog(),
        },
    );
}

async function fixture(mode: Mode) {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-deadline-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const requests: string[] = [];
    await install(context, mode, requests);
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    return {
        context,
        directory,
        requests,
        counts: () => context.pages()[0]!.evaluate(() => JSON.parse(sessionStorage.getItem("deadlineCounts")!)),
        async cleanup() {
            launch.mock.restore();
            await browser.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("TicketPlus 全程期限：登入耗時不計入，期限未滿十分鐘仍抵達資料頁", { timeout: 20_000 }, async () => {
    const site = await fixture("direct");
    let now = 0;
    try {
        await site.context.route("https://ticketplus.com.tw/", route =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedOutHome }),
        );
        const pending = runTicketPlus(settings, {
            lease: acquirePurchaseLease(site.directory),
            deadlineNow: () => now,
            onEvent: event => {
                if (event.type === "stage" && event.stage === "submitting") now += 599_000;
            },
        });
        const page = site.context.pages()[0]!;
        await page.getByText("會員登入").waitFor();
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(site.requests.length, 0, "登入未完成前不載入活動");
        now = 900_000;
        await page.evaluate(html => {
            document.body.innerHTML = html;
        }, loggedInHome);
        const result = await pending;
        assert.equal(
            result.outcome,
            "payment-ready",
            JSON.stringify({ result, counts: await site.counts(), url: site.context.pages()[0]!.url() }),
        );
        assert.equal(result.stopReason, undefined);

        assert.equal(
            site.requests.filter(url => new URL(url).pathname.startsWith("/activity/")).length,
            1,
            "立即開始不增加活動頁刷新",
        );
        assert.deepEqual(await site.counts(), { session: 1, plus: 2, submit: 1, dismiss: 0, other: 0 });
        assert(purchaseOccupied(site.directory));
        await site.context.close();
        assert(!purchaseOccupied(site.directory));
    } finally {
        await site.cleanup();
    }
});

test("TicketPlus 全程期限：選場次與選票累積同一期限，到期不提交且保留占用", { timeout: 20_000 }, async () => {
    const site = await fixture("direct");
    const stages: string[] = [];
    let now = 0;
    try {
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(site.directory),
            deadlineNow: () => now,
            onEvent: event => {
                if (event.type !== "stage") return;
                stages.push(event.stage);
                if (["selecting-session", "selecting-tickets", "submitting"].includes(event.stage)) now += 200_000;
            },
        });
        assert.deepEqual(stages, [
            "starting",
            "checking-login",
            "opening-activity",
            "selecting-session",
            "selecting-tickets",
            "submitting",
        ]);
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "time-limit");
        assert.equal(result.progress.submitAttempted, false);
        assert.deepEqual(await site.counts(), { session: 1, plus: 2, submit: 0, dismiss: 0, other: 0 });
        assert(purchaseOccupied(site.directory));
        await site.context.close();
        assert(!purchaseOccupied(site.directory));
    } finally {
        await site.cleanup();
    }
});

test("TicketPlus 全程期限：排隊與售完到期保留提交事實，不重送或關閉失敗彈窗", { timeout: 20_000 }, async () => {
    for (const mode of ["queue", "failure"] as const) {
        const site = await fixture(mode);
        let now = 0;
        try {
            const result = await runTicketPlus(settings, {
                lease: acquirePurchaseLease(site.directory),
                deadlineNow: () => now,
                onEvent: event => {
                    if (event.type === "submission" && (event.progress.sawQueue || event.progress.failure))
                        now = 600_000;
                },
            });
            assert.equal(result.outcome, mode === "queue" ? "unknown" : "rejected");
            assert.equal(result.stopReason, "time-limit");
            assert.equal(result.progress.submitAttempted, true);
            assert.equal(result.progress.sawQueue, mode === "queue");
            assert.equal(Boolean(result.progress.failure), mode === "failure");
            assert.equal(result.progress.dismissAttempted, false);
            assert.deepEqual(await site.counts(), { session: 1, plus: 2, submit: 1, dismiss: 0, other: 0 });
            assert(purchaseOccupied(site.directory));
            await site.context.close();
            assert(!purchaseOccupied(site.directory));
        } finally {
            await site.cleanup();
        }
    }
});

test("TicketPlus 全程期限：真實受遮罩點擊縮短期限，收尾後解除遮罩不會遲到點擊", { timeout: 15_000 }, async () => {
    const site = await fixture("direct");
    const page = site.context.pages()[0]!;
    const prototype = Object.getPrototypeOf(page.getByRole("button"));
    const originalClick = prototype.click;
    const timeouts: number[] = [];
    const hook = mock.method(prototype, "click", function (this: unknown, options: { timeout: number }) {
        timeouts.push(options.timeout);
        return originalClick.call(this, options);
    });
    let offset = 0;
    const started = performance.now();
    try {
        await site.context.addInitScript(() => {
            if (location.pathname.startsWith("/activity/"))
                document.addEventListener("DOMContentLoaded", () => {
                    document.body.insertAdjacentHTML(
                        "beforeend",
                        '<div id="deadline-cover" style="position:fixed;inset:0;z-index:999;background:white"></div>',
                    );
                });
        });
        // 遮罩確實阻擋 Playwright 原生點擊，不以假的 click 結果代替。
        const result = await runTicketPlus(settings, {
            lease: acquirePurchaseLease(site.directory),
            deadlineNow: () => offset + performance.now() - started,
            onEvent: event => {
                if (event.type === "stage" && event.stage === "selecting-session") offset = 599_000;
            },
        });
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "time-limit");
        assert.equal(result.progress.submitAttempted, false);
        assert.equal(timeouts.length, 1, "必須真的進入原生點擊，不能只在之前的讀取到期");
        assert(timeouts[0]! > 0 && timeouts[0]! <= 1_000, "不得沿用場次原本的 5 秒 timeout 或傳入 0");

        // 流程回報結束後解除阻擋，確認不存在尚未收尾的點擊。
        await page.locator("#deadline-cover").evaluate(element => element.remove());
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.deepEqual(await site.counts(), { session: 0, plus: 0, submit: 0, dismiss: 0, other: 0 });
        assert(purchaseOccupied(site.directory));
        await site.context.close();
        assert(!purchaseOccupied(site.directory));
    } finally {
        hook.mock.restore();
        await site.cleanup();
    }
});

test("TicketPlus 開賣等待：等待跨過十分鐘不耗期限，到點後同一期限仍可阻止提交", { timeout: 20_000 }, async () => {
    const site = await fixture("direct");
    let deadlineClock = 0;
    let saleClock = Date.parse("2026-10-30T11:59:59+08:00");
    const stages: string[] = [];
    try {
        const result = await runTicketPlus(
            { ...settings, saleSchedule: { saleAt: "2026-10-30T12:00:00+08:00" } },
            {
                lease: acquirePurchaseLease(site.directory),
                deadlineNow: () => deadlineClock,
                saleNow: () => saleClock,
                onEvent: event => {
                    if (event.type !== "stage") return;
                    stages.push(event.stage);
                    if (event.stage === "waiting-for-sale") {
                        setTimeout(() => {
                            deadlineClock = 1_200_000;
                            saleClock += 1000;
                        }, 100);
                    }
                    if (event.stage === "submitting") deadlineClock += 600_000;
                },
            },
        );
        assert.equal(site.requests.filter(url => new URL(url).pathname === "/").length, 1);
        assert.equal(
            site.requests.filter(url => new URL(url).pathname.startsWith("/activity/")).length,
            2,
            "排程等待只增加一次開賣前刷新",
        );
        assert(stages.includes("waiting-for-sale"));
        assert(stages.indexOf("waiting-for-sale") < stages.indexOf("selecting-session"));
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "time-limit");
        assert.deepEqual(await site.counts(), { session: 1, plus: 2, submit: 0, dismiss: 0, other: 0 });
    } finally {
        await site.cleanup();
    }
});
