import { installRefreshExample } from "./fixtures/ticketplus/refreshPage.js";
import { loggedInHome } from "./fixtures/ticketplus/loginPage.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTicketPlusCycle } from "../src/platforms/ticketplus/purchaseCycle.js";
import type { TicketPlusCycleEvent } from "../src/platforms/ticketplus/purchaseCycle.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { runTicketPlus } from "../src/app/runTicketPlus.js";
import { ticketPlusResultMessage } from "../src/app/ticketPlusPresentation.js";
import { acquirePurchaseLease, purchaseOccupied } from "../src/app/purchaseLock.js";
import type { TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";
import { installCyclePage, cycleState } from "./fixtures/ticketplus/cyclePage.js";
import type { CycleMode } from "./fixtures/ticketplus/cyclePage.js";

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
    targets: ["A區", "B區"].map(ticketType => ({ date: "2026-10-30", time: "20:00", ticketType, quantity: 2 })),
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
};
async function withPage(mode: CycleMode, run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        await installCyclePage(context, mode);
        const page = await context.newPage();
        await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
        await run(page);
        assert(
            !(await cycleState(page)).actions.some(action => ["information-next", "change", "other"].includes(action)),
        );
    } finally {
        await browser.close();
    }
}

test("循環：A 真提交售完清零後只試 B，不額外再試 A；成功停資料頁", async () => {
    await withPage("success", async page => {
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "information-ready");
        assert.equal(result.submissionAttempts, 2);
        assert.equal(result.progress.failure, undefined);
        assert.deepEqual(await cycleState(page), {
            actions: ["A區+", "A區+", "submit", "dismiss", "B區+", "B區+", "submit"],
            submissions: [[{ name: "A區", quantity: 2 }], [{ name: "B區", quantity: 2 }]],
        });
    });
});

test("循環：A 售完後 B 不明，舊 failure 不污染 B，也不刷新或第三次提交", async () => {
    await withPage("unknown", async page => {
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "unknown");
        assert.equal(result.progress.failure, undefined);
        assert.equal(result.submissionAttempts, 2);
        assert.equal((await cycleState(page)).submissions.length, 2);
        assert(!(await cycleState(page)).actions.includes("refresh"));
    });
});

test("循環：A 畫面售完、B 提交售完，下一個使用原始 C 索引", async () => {
    await withPage("skip-A", async page => {
        const result = await runTicketPlusCycle(
            page,
            { ...settings, targets: [...settings.targets, { ...settings.targets[0]!, ticketType: "C區" }] },
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "information-ready");
        assert.deepEqual((await cycleState(page)).submissions, [
            [{ name: "B區", quantity: 2 }],
            [{ name: "C區", quantity: 2 }],
        ]);
    });
});

test("循環：A/B 售完且非目標 C 有庫存，單次更新後停止；不是全頁售完才更新", async () => {
    await withPage("all-sold-out", async page => {
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "stopped");
        assert.equal(result.submissionAttempts, 0);
        assert("refresh" in result);
        assert.equal(result.refresh?.reason, "completion-unverified");
        assert.deepEqual(await cycleState(page), { actions: ["refresh"], submissions: [] });
    });
});

test("循環：本輪全部提交售完，只更新一次、不假裝已具備跨輪完成判定", async () => {
    await withPage("all-rejected", async page => {
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.submissionAttempts, 2);
        assert.equal(result.progress.submitAttempted, false);
        assert.equal(result.outcome, "stopped");
        assert.match(ticketPlusResultMessage(result), /先前 2 次提交已確認售完/);
        assert.match(ticketPlusResultMessage(result), /更新完成/);
        assert.deepEqual((await cycleState(page)).actions, [
            "A區+",
            "A區+",
            "submit",
            "dismiss",
            "B區+",
            "B區+",
            "submit",
            "dismiss",
            "refresh",
        ]);
    });
});

test("循環：殘留張數與一般失敗停止，不候補也不更新", async () => {
    for (const mode of ["residue", "general-failure"] as const) {
        await withPage(mode, async page => {
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                new TicketPlusRunControl(),
                undefined,
                options,
            );
            assert.equal(result.outcome, "rejected");
            assert.equal(result.submissionAttempts, 1);
            if (mode === "residue") assert.equal(result.reselectionFailure, "remaining-quantity");
            assert.deepEqual((await cycleState(page)).actions, ["A區+", "A區+", "submit", "dismiss"]);
        });
    }
});

test("循環：非目標已選票、壞列、缺目標、歧義都不能變成全部售完", async () => {
    for (const variant of ["selected", "broken", "missing", "duplicate"] as const) {
        await withPage("all-sold-out", async page => {
            await page.evaluate(variant => {
                const rows = document.querySelectorAll(".row.py-1.py-md-4");
                if (variant === "selected") rows[2]!.querySelector(".count-button > div")!.textContent = "1";
                if (variant === "broken") rows[2]!.querySelector(".count-button")!.remove();
                if (variant === "missing") rows[0]!.remove();
                if (variant === "duplicate") document.body.append(rows[0]!.cloneNode(true));
            }, variant);
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                new TicketPlusRunControl(),
                undefined,
                options,
            );
            assert.equal(result.outcome, "stopped");
            assert.deepEqual((await cycleState(page)).actions, []);
        });
    }
});

test("循環：熱賣中不是零庫存，停用加票也不是售完", async () => {
    await withPage("skip-A", async page => {
        await page
            .locator(".row.py-1.py-md-4")
            .nth(1)
            .locator("button:has(.mdi-plus)")
            .evaluate(button => ((button as HTMLButtonElement).disabled = true));
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "stopped");
        assert.equal(result.submissionAttempts, 0);
        assert.deepEqual((await cycleState(page)).actions, []);
    });
});

test("循環：首次保留補差張數；再次選票前畫面被加票仍阻擋", async context => {
    await withPage("success", async page => {
        await page
            .locator(".count-button > div")
            .first()
            .evaluate(element => {
                element.textContent = "1";
            });
        const result = await runTicketPlusCycle(
            page,
            settings,
            session,
            new TicketPlusRunControl(),
            undefined,
            options,
        );
        assert.equal(result.outcome, "information-ready");
        assert.equal((await cycleState(page)).actions.filter(action => action === "A區+").length, 1);
    });
    await withPage("success", async page => {
        const original = page.evaluate.bind(page);
        let changeBeforeNextRead = false;
        let changed = false;
        const read = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            if (changeBeforeNextRead) {
                changeBeforeNextRead = false;
                await original(() => {
                    document.querySelectorAll(".count-button > div")[1]!.textContent = "1";
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
                new TicketPlusRunControl(),
                event => {
                    if (event.type === "attempt-reset" && event.submissionAttempts === 1) changeBeforeNextRead = true;
                },
                options,
            );
            assert.equal(changed, true);
            assert.equal(result.outcome, "stopped");
            assert.equal(result.submissionAttempts, 1);
            assert("priorityFailure" in result);
            assert.equal(result.priorityFailure, "extra-tickets");
            assert.equal((await cycleState(page)).submissions.length, 1);
            assert(!(await cycleState(page)).actions.includes("B區+"));
        } finally {
            read.mock.restore();
        }
    });
});

test("循環：等待更新時停止／期限到期，先前售完不變成未知且不重設時間", async () => {
    for (const mode of ["stop", "deadline"] as const) {
        await withPage("all-rejected", async page => {
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
                    if (event.type === "stage" && event.stage === "waiting-to-refresh") {
                        if (mode === "stop") controller.abort();
                        else now = 60000;
                    }
                },
                options,
            );
            assert.equal(result.outcome, "stopped");
            assert.equal(result.stopReason, mode === "stop" ? "user-stop" : "time-limit");
            assert.equal(result.submissionAttempts, 2);
            assert.match(ticketPlusResultMessage(result), /先前 2 次提交已確認售完/);
            assert(!(await cycleState(page)).actions.includes("refresh"));
        });
    }
});

test("循環：B 尚未提交停止與 B 排隊中停止分開分類", async () => {
    for (const stage of ["before", "queue"] as const) {
        await withPage("queue", async page => {
            const controller = new AbortController();
            let attempts = 0;
            const observe = (event: TicketPlusCycleEvent) => {
                if (event.type === "attempt-reset") attempts = event.submissionAttempts;
                if (stage === "before" && event.type === "attempt-reset" && attempts === 1) controller.abort();
                if (stage === "queue" && event.type === "submission" && event.progress.sawQueue) controller.abort();
            };
            const result = await runTicketPlusCycle(
                page,
                settings,
                session,
                new TicketPlusRunControl(controller.signal),
                observe,
                options,
            );
            assert.equal(result.outcome, stage === "before" ? "stopped" : "unknown");
            assert.equal(result.stopReason, "user-stop");
            assert.equal(result.submissionAttempts, stage === "before" ? 1 : 2);
            assert.equal(result.progress.failure, undefined);
            assert(!(await cycleState(page)).actions.includes("refresh"));
        });
    }
});

test("正式 runner：同輪 A 售完轉 B 成功／不明，保留單一瀏覽器與占用", async t => {
    for (const mode of ["success", "unknown"] as const) {
        const directory = await mkdtemp(join(tmpdir(), "ticketplus-cycle-runner-"));
        const browser = await chromium.launch();
        const context = await browser.newContext();
        await installCyclePage(context, mode);
        await context.route("https://ticketplus.com.tw/", route =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: loggedInHome }),
        );
        await context.newPage();
        const launch = t.mock.method(chromium, "launchPersistentContext", async () => context);
        try {
            const result = await runTicketPlus(settings, {
                lease: acquirePurchaseLease(directory),
            });
            assert.equal(result.outcome, mode === "success" ? "information-ready" : "unknown");

            assert.equal(launch.mock.callCount(), 1);
            assert.equal(
                (await cycleState(context.pages()[0]!)).actions.filter(action => action === "session").length,
                1,
            );
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

test("循環：目標售完後實際更新完成仍停止，不開始第二輪或宣稱購票成功", async () => {
    await withPage("all-sold-out", async page => {
        await installRefreshExample(page);
        const pending = runTicketPlusCycle(page, settings, session, new TicketPlusRunControl(), undefined, options);
        await page.waitForFunction(() => window.refreshExample.phase === "partial");
        await page.evaluate(() => window.refreshExample.restoreData());
        await page.evaluate(() => window.refreshExample.restoreButton());
        const result = await pending;
        assert.equal(result.outcome, "stopped");
        assert.equal(result.reason, "refresh-completed");
        assert.equal(result.submissionAttempts, 0);
        assert("refresh" in result);
        assert.equal(result.refresh?.kind, "completed");
        assert.match(ticketPlusResultMessage(result), /更新.*完成/);
        assert.doesNotMatch(ticketPlusResultMessage(result), /購票成功|取得最新庫存/);
        assert.deepEqual(await cycleState(page), { actions: ["refresh"], submissions: [] });
    });
});
