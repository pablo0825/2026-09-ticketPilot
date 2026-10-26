import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTicketPlus } from "../../../src/app/flows/ticketplus/runTicketPlus.js";
import { acquirePurchaseLease, purchaseOccupied } from "../../../src/storage/purchaseLock.js";
import { loggedInHome } from "../../fixtures/ticketplus/loginPage.js";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { runTicketPlusCycle } from "../../../src/platforms/ticketplus/purchaseCycle.js";
import { TicketPlusRunControl } from "../../../src/platforms/ticketplus/runControl.js";
import type { TicketPlusActivitySettings } from "../../../src/config/platforms/ticketplus/activitySettings.js";
import { installRoundPage, roundState } from "../../fixtures/ticketplus/roundPage.js";
import type { RoundMode } from "../../fixtures/ticketplus/roundPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};
const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: session.eventName,
    targets: ["A區", "B區"].map(ticketType => ({ date: session.date, time: session.time, ticketType, quantity: 1 })),
};
const options = {
    refreshDelayMs: 20,
    selection: { timeoutMs: 4000, changeTimeoutMs: 500, pollIntervalMs: 20 },
    submission: {
        totalTimeoutMs: 5000,
        preflightTimeoutMs: 2000,
        submitWaitMs: 500,
        queueWaitMs: 700,
        clickTimeoutMs: 500,
        closeTimeoutMs: 1000,
        readTimeoutMs: 500,
        pollIntervalMs: 20,
    },
    refresh: { timeoutMs: 1000 },
};
async function withPage(mode: RoundMode, run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        await installRoundPage(context, mode);
        const page = await context.newPage();
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
        await run(page);
        // 資料頁最多勾一次條款、按一次下一步
        const actions = (await roundState(page)).actions;
        assert(actions.filter(action => action === "information-next").length <= 1);
        assert(actions.filter(action => action === "terms").length <= 1);
    } finally {
        await browser.close();
    }
}

for (const [mode, count, selected] of [
    ["fifth-A", 4, "A區"],
    ["both", 1, "A區"],
    ["only-B", 1, "B區"],
] as const) {
    test(`跨輪：${mode} 使用真更新過渡後重新按順位選票`, async () => {
        await withPage(mode, async page => {
            const control = new TicketPlusRunControl();
            control.startDeadline(1);
            const result = await runTicketPlusCycle(page, settings, session, control, undefined, options);
            assert.equal(result.outcome, "payment-ready");
            assert.equal(result.submissionAttempts, 1);
            assert.deepEqual(await roundState(page), {
                actions: [
                    ...Array<string>(count).fill("refresh"),
                    `${selected}+`,
                    "submit",
                    "terms",
                    "information-next",
                ],
                refreshes: count,
                submissions: [[{ name: selected, quantity: 1 }]],
            });
        });
    });
}

test("跨輪：第二次更新沒有過渡，不能沿用第一次證據", async () => {
    await withPage("second-inert", async page => {
        const control = new TicketPlusRunControl();
        control.startDeadline(1);
        const result = await runTicketPlusCycle(page, settings, session, control, undefined, options);
        assert.equal(result.outcome, "stopped");
        assert.equal(result.submissionAttempts, 0);
        assert("refresh" in result);
        assert.equal(result.refresh?.reason, "completion-unverified");
        assert.deepEqual(await roundState(page), { actions: ["refresh", "refresh"], refreshes: 2, submissions: [] });
    });
});

for (const mode of ["stop", "deadline"] as const) {
    test(`跨輪：兩輪更新後 ${mode}，不開始第三次更新`, async () => {
        await withPage("never", async page => {
            const controller = new AbortController();
            let now = 0;
            let waits = 0;
            const control = new TicketPlusRunControl(controller.signal, () => now);
            control.startDeadline(1);
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                control,
                event => {
                    if (event.type === "stage" && event.stage === "waiting-to-refresh" && ++waits === 3) {
                        if (mode === "stop") controller.abort();
                        else now = 60000;
                    }
                },
                options,
            );
            assert.equal(result.outcome, "stopped");
            assert.equal(result.stopReason, mode === "stop" ? "user-stop" : "time-limit");
            assert.equal(result.submissionAttempts, 0);
            assert.deepEqual(await roundState(page), {
                actions: ["refresh", "refresh"],
                refreshes: 2,
                submissions: [],
            });
        });
    });
}

for (const mode of ["stop", "deadline"] as const) {
    test(`跨輪：更新完成邊界 ${mode} 優先於新一輪選票`, async () => {
        await withPage("both", async page => {
            const controller = new AbortController();
            let now = 0;
            const control = new TicketPlusRunControl(controller.signal, () => now);
            control.startDeadline(1);
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                control,
                event => {
                    if (event.type === "attempt-reset" && event.reason === "refreshed") {
                        if (mode === "stop") controller.abort();
                        else now = 60000;
                    }
                },
                options,
            );
            assert.equal(result.outcome, "stopped");
            assert.equal(result.stopReason, mode === "stop" ? "user-stop" : "time-limit");
            assert.equal(result.submissionAttempts, 0);
            assert.deepEqual(await roundState(page), { actions: ["refresh"], refreshes: 1, submissions: [] });
        });
    });
}

test("跨輪：前輪零提交仍拒絕更新完成後新增的殘留張數", async context => {
    await withPage("both", async page => {
        const control = new TicketPlusRunControl();
        control.startDeadline(1);
        const original = page.evaluate.bind(page);
        let inject = false;
        let changed = false;
        const read = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            // 模擬使用者在更新完成後、下一輪讀取前手動加一張，不影響 fixture 放票規則。
            if (inject) {
                inject = false;
                await original(() => {
                    document.querySelector(".count-button > div")!.textContent = "1";
                });
                changed = true;
            }
            return original(...args);
        });
        try {
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                control,
                event => {
                    if (event.type === "attempt-reset" && event.reason === "refreshed") inject = true;
                },
                options,
            );
            assert.equal(changed, true);
            assert.equal(result.outcome, "stopped");
            assert.equal(result.submissionAttempts, 0);
            assert.equal(result.reason, "ticket-selection-stopped");
            assert.deepEqual(await roundState(page), { actions: ["refresh"], refreshes: 1, submissions: [] });
        } finally {
            read.mock.restore();
        }
    });
});

test("正式 runner：更新後跨輪成功只啟動一次瀏覽器且保留占用至關閉", async t => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-rounds-runner-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await installRoundPage(context, "both");
    await context.route("https://ticketplus.com.tw/", route =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedInHome }),
    );
    await context.newPage();
    const launch = t.mock.method(chromium, "launchPersistentContext", async () => context);
    try {
        const result = await runTicketPlus(settings, { lease: acquirePurchaseLease(directory) });
        assert.equal(result.outcome, "payment-ready");
        assert.equal(launch.mock.callCount(), 1);
        assert.deepEqual(await roundState(context.pages()[0]!), {
            actions: ["session", "refresh", "A區+", "submit", "terms", "information-next"],
            refreshes: 1,
            submissions: [[{ name: "A區", quantity: 1 }]],
        });
        assert(purchaseOccupied(directory));
        await context.close();
        assert(!purchaseOccupied(directory));
    } finally {
        launch.mock.restore();
        await browser.close();
        await rm(directory, { recursive: true, force: true });
    }
});
