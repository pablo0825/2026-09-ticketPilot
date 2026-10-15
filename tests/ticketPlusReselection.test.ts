import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import type { TicketSelectionPage } from "../src/platforms/ticketplus/ticketSelectionPage.js";
import { inspectTicketPlusReselection } from "../src/platforms/ticketplus/reselectionReadiness.js";
import { runTicketPlusSubmission } from "../src/platforms/ticketplus/submissionOutcome.js";
import type { TicketPlusSubmissionResult } from "../src/platforms/ticketplus/submissionOutcome.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import { soldOut } from "./fixtures/ticketplus/pages.js";
import { installSubmission, submissionCounts, failureDialog } from "./fixtures/ticketplus/submissionPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: session.eventName,
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
const selected: TicketSelectionPage = {
    kind: "ticket-selection",
    ...session,
    nextEnabled: true,
    tickets: [
        {
            name: "預售票",
            selectedQuantity: 2,
            saleStatus: "selling",
            remainingQuantity: null,
            canIncrease: true,
            canDecrease: true,
        },
    ],
};
const options = {
    preflightTimeoutMs: 2000,
    submitWaitMs: 1000,
    queueWaitMs: 1000,
    totalTimeoutMs: 5000,
    clickTimeoutMs: 700,
    closeTimeoutMs: 1000,
    readTimeoutMs: 1000,
    pollIntervalMs: 20,
};
const counts = { orderClicks: 1, dismissClicks: 1, infoClicks: 0, otherClicks: 0, termsChanges: 0 };

async function zeroQuantities(page: Page): Promise<void> {
    await page.evaluate(() => {
        document.querySelectorAll(".count-button > div").forEach(element => {
            element.textContent = "0";
        });
        document.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
            if (button.textContent === "下一步") button.disabled = true;
        });
    });
}

async function withFailure(
    run: (
        page: Page,
        result: TicketPlusSubmissionResult,
        requests: () => number,
        control: TicketPlusRunControl,
    ) => Promise<void>,
    message?: string,
): Promise<void> {
    const browser = await chromium.launch();
    try {
        // 保留原 fixture 關窗後的兩張預售票，不替正式流程自動清票。
        const page = await browser.newPage();
        const requests = await installSubmission(page, "failure", failureDialog(message));
        const control = new TicketPlusRunControl();
        control.startDeadline(1);
        const result = await runTicketPlusSubmission(page, settings, selected, options, undefined, control);
        assert.equal(result.outcome, "rejected");
        assert.equal(result.progress.dismissal, "confirmed");

        // 每個案例也驗證唯讀核對沒有修改提交紀錄、點擊或刷新。
        const before = JSON.stringify(result);
        const requestCount = requests();
        await run(page, result, requests, control);
        assert.equal(JSON.stringify(result), before);
        assert.deepEqual(await submissionCounts(page), counts);
        assert.equal(requests(), requestCount);
    } finally {
        await browser.close();
    }
}

test("TicketPlus 重選核對：實際售完關窗後殘留兩張阻擋，清零且下一步停用仍可放行", async () => {
    await withFailure(async (page, result, _requests, control) => {
        assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "remaining-quantity",
        });
        await zeroQuantities(page);
        const ready = await inspectTicketPlusReselection(page, session, result, control);
        assert.equal(ready.kind, "ready");
        if (ready.kind !== "ready") assert.fail();
        assert.equal(ready.snapshot.nextEnabled, false);
        assert.deepEqual(
            ready.snapshot.tickets.map(ticket => ticket.selectedQuantity),
            [0, 0, 0],
        );
    });
});

test("TicketPlus 重選核對：一般購票失敗與限購即使清零也不放行", async () => {
    for (const message of ["購票失敗", "本活動有限制購票總張數"]) {
        await withFailure(async (page, result) => {
            assert.equal(result.progress.failure, "purchase-failed");
            await zeroQuantities(page);
            assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
                kind: "blocked",
                reason: "failure-not-sold-out",
            });
        }, message);
    }
});

test("TicketPlus 重選核對：非目標票有張數、排隊、資料頁與未知彈窗都不放行", async () => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        await page
            .locator(".count-button > div")
            .first()
            .evaluate(element => {
                element.textContent = "1";
            });
        assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "remaining-quantity",
        });
        for (const phase of ["queue", "information", "unknown"] as const) {
            await page.evaluate(phase => window.submissionFixture.show(phase), phase);
            assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
                kind: "blocked",
                reason: "unexpected-page",
            });
        }
        await page.evaluate(() => window.submissionFixture.show("order"));
        await zeroQuantities(page);
        await page.locator("body").evaluate(body => {
            body.insertAdjacentHTML("beforeend", '<div role="dialog">未知提示</div>');
        });
        assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "unexpected-page",
        });
    });
});

test("TicketPlus 重選核對：活動、場次、名稱、日期、時間分別不符都阻擋", async () => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        for (const [key, value] of Object.entries({
            eventId: "other-event",
            sessionId: "other-session",
            eventName: "另一活動",
            date: "2026-10-31",
            time: "21:00",
        })) {
            assert.deepEqual(
                await inspectTicketPlusReselection(
                    page,
                    { ...session, [key]: value },
                    result,
                    new TicketPlusRunControl(),
                ),
                { kind: "blocked", reason: "identity-mismatch" },
            );
        }
    });
});

test("TicketPlus 重選核對：未提交、不明結果、關窗未確認及既有停止不讀 DOM", async context => {
    await withFailure(async (page, result) => {
        const read = context.mock.method(page, "evaluate", async () => {
            throw new Error("不應讀取 DOM");
        });
        const cases = [
            [{ ...result, outcome: "unknown" as const, reason: "wait-timeout" as const }, "submission-not-rejected"],
            [{ ...result, progress: { ...result.progress, submitAttempted: false } }, "submission-not-attempted"],
            [
                { ...result, progress: { ...result.progress, dismissal: "unconfirmed" as const } },
                "dismissal-unconfirmed",
            ],
            [{ ...result, stopReason: "time-limit" as const }, "submission-stopped"],
        ] as const;
        for (const [prior, reason] of cases) {
            const inspected = await inspectTicketPlusReselection(page, session, prior, new TicketPlusRunControl());
            assert.equal(inspected.kind, "blocked");
            if (inspected.kind === "blocked") assert.equal(inspected.reason, reason);
        }
        assert.deepEqual(
            await inspectTicketPlusReselection(page, { ...session, sessionId: "" }, result, new TicketPlusRunControl()),
            { kind: "blocked", reason: "invalid-session" },
        );
        assert.deepEqual(
            await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl(), { readTimeoutMs: 0 }),
            { kind: "blocked", reason: "invalid-options" },
        );
        assert.equal(read.mock.callCount(), 0);
        read.mock.restore();
    });
});

test("TicketPlus 重選核對：人工停止與全程到期不可放行", async () => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
            inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl(controller.signal)),
            (error: unknown) => error instanceof TicketPlusStopError && error.stopReason === "user-stop",
        );
        let now = 0;
        const control = new TicketPlusRunControl(undefined, () => now);
        control.startDeadline(1);
        now = 60000;
        await assert.rejects(
            inspectTicketPlusReselection(page, session, result, control),
            (error: unknown) => error instanceof TicketPlusStopError && error.stopReason === "time-limit",
        );
    });
});

test("TicketPlus 重選核對：讀取中取消與本地逾時不會被晚到結果放行", async context => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        const original = page.evaluate.bind(page);
        let entered!: () => void;
        let finish!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        const gate = new Promise<void>(resolve => {
            finish = resolve;
        });
        const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            entered();
            await gate;
            return original(...args);
        });
        const controller = new AbortController();
        const pending = inspectTicketPlusReselection(
            page,
            session,
            result,
            new TicketPlusRunControl(controller.signal),
        );
        await started;
        controller.abort();
        await assert.rejects(pending, TicketPlusStopError);
        assert.deepEqual(
            await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl(), {
                readTimeoutMs: 30,
            }),
            { kind: "blocked", reason: "read-timeout" },
        );
        finish();
        mock.mock.restore();
    });
});

test("TicketPlus 重選核對：實際關窗回到排隊仍阻擋，彈窗自行消失可核對零張頁", async () => {
    const browser = await chromium.launch();
    try {
        // 關窗後仍排隊的情境保留正式關窗 confirmed，證明它本身不足以放行。
        const page = await browser.newPage();
        await installSubmission(page, "failure");
        await page.evaluate(() =>
            document.addEventListener("click", event => {
                if ((event.target as Element).closest('[data-fixture="dismiss"]'))
                    window.submissionFixture.show("queue");
            }),
        );
        const queued = await runTicketPlusSubmission(page, settings, selected, options);
        assert.equal(queued.progress.dismissal, "confirmed");
        assert.deepEqual(await inspectTicketPlusReselection(page, session, queued, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "unexpected-page",
        });
        assert.deepEqual(await submissionCounts(page), counts);

        // 在正式失敗觀察後移除彈窗，讓提交模組自行辨識 disappeared。
        const other = await browser.newPage();
        await installSubmission(other, "failure");
        const disappeared = await runTicketPlusSubmission(other, settings, selected, options, async progress => {
            if (progress.failure && !progress.dismissAttempted) {
                await other.evaluate(() => {
                    document
                        .querySelectorAll<HTMLElement>('[role="dialog"], .v-dialog, .v-dialog__content')
                        .forEach(element => {
                            element.style.display = "none";
                        });
                });
            }
        });
        assert.equal(disappeared.progress.dismissal, "disappeared");
        await zeroQuantities(other);
        const ready = await inspectTicketPlusReselection(other, session, disappeared, new TicketPlusRunControl());
        assert.equal(ready.kind, "ready");
        assert.deepEqual(await submissionCounts(other), { ...counts, dismissClicks: 0 });
    } finally {
        await browser.close();
    }
});

test("TicketPlus 重選核對：全部庫存售完仍可放行零張選票頁", async () => {
    await withFailure(async (page, result) => {
        await page.locator(".row.py-1").evaluateAll((rows, html) => {
            rows.forEach((row, index) => {
                row.outerHTML = html.replace("身障票", `售完票${index}`);
            });
        }, soldOut);
        const ready = await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl());
        assert.equal(ready.kind, "ready");
        if (ready.kind === "ready")
            assert(
                ready.snapshot.tickets.every(
                    ticket => ticket.saleStatus === "sold-out" && ticket.selectedQuantity === 0,
                ),
            );
    });
});

test("TicketPlus 重選核對：既有全程期限在讀取中到期，不重置或回傳晚到成功", async context => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        let now = 0;
        const control = new TicketPlusRunControl(undefined, () => now);
        control.startDeadline(1);
        now = 59980;
        const original = page.evaluate.bind(page);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            entered();
            await gate;
            return original(...args);
        });
        const pending = inspectTicketPlusReselection(page, session, result, control);
        await started;
        now = 60000;
        await assert.rejects(
            pending,
            (error: unknown) => error instanceof TicketPlusStopError && error.stopReason === "time-limit",
        );
        release();
        mock.mock.restore();
    });
});

test("TicketPlus 重選核對：缺少票種資料不可用空集合當全部零張", async () => {
    await withFailure(async (page, result) => {
        await zeroQuantities(page);
        await page.locator(".row.py-1").evaluateAll(rows => rows.forEach(row => row.remove()));
        assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "unexpected-page",
        });
    });
});

test("TicketPlus 重選核對：真實頁面關閉回報讀取失敗而非售完或 ready", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installSubmission(page, "failure");
        const result = await runTicketPlusSubmission(page, settings, selected, options);
        assert.equal(result.outcome, "rejected");
        await page.close();
        assert.deepEqual(await inspectTicketPlusReselection(page, session, result, new TicketPlusRunControl()), {
            kind: "blocked",
            reason: "read-failed",
        });
    } finally {
        await browser.close();
    }
});
