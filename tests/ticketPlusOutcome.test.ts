import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { stoppedSubmissionResult, runTicketPlusSubmission } from "../src/platforms/ticketplus/submissionOutcome.js";
import { emptySubmissionProgress, TicketPlusSubmissionError } from "../src/platforms/ticketplus/ticketSubmission.js";
import type { SubmissionProgress } from "../src/platforms/ticketplus/ticketSubmission.js";
import type { TicketSelectionPage } from "../src/platforms/ticketplus/ticketSelectionPage.js";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import { installSubmission, submissionCounts } from "./fixtures/ticketplus/submissionPage.js";

const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
const selected: TicketSelectionPage = {
    kind: "ticket-selection",
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
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

test("TicketPlus 結果：未提交停止、提交後未知、明確失敗保留關閉狀態", () => {
    assert.equal(stoppedSubmissionResult(new Error("private")).outcome, "stopped");
    const attempted = { ...emptySubmissionProgress(), submitAttempted: true };
    assert.equal(stoppedSubmissionResult(new Error("private"), attempted).outcome, "unknown");
    for (const dismissal of ["not-attempted", "confirmed", "unconfirmed", "disappeared"] as const) {
        const progress: SubmissionProgress = { ...attempted, failure: "sold-out", dismissal };
        const result = stoppedSubmissionResult(new TicketPlusSubmissionError("dismiss-unconfirmed", progress));
        assert.equal(result.outcome, "rejected");
        assert.equal(result.progress.dismissal, dismissal);
        assert(!JSON.stringify(result).includes("private"));
    }
    const downgraded = stoppedSubmissionResult(
        new TicketPlusSubmissionError("read-failed", emptySubmissionProgress()),
        attempted,
    );
    assert.equal(downgraded.outcome, "unknown");
});

test("TicketPlus 結果：提交前通知、通知拋錯或拒絕不影響真實流程", async () => {
    for (const asynchronous of [false, true]) {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await installSubmission(page, "direct");
            let observed = false;
            const result = await runTicketPlusSubmission(page, settings, selected, {}, progress => {
                observed = progress.submitAttempted;
                assert(Object.isFrozen(progress));
                if (asynchronous) return Promise.reject(new Error("observer private"));
                throw new Error("observer private");
            });
            assert.equal(observed, true);
            assert.equal(result.outcome, "information-ready");
            assert.equal(result.progress.submitAttempted, true);
            assert.deepEqual(await submissionCounts(page), {
                orderClicks: 1,
                dismissClicks: 0,
                infoClicks: 0,
                otherClicks: 0,
                termsChanges: 0,
            });
        } finally {
            await browser.close();
        }
    }
});

test("TicketPlus 結果：通知已提交時頁面尚未收到點擊，失敗仍保持終局", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installSubmission(page, "failure");
        let beforeClick: ReturnType<typeof submissionCounts> | undefined;
        const result = await runTicketPlusSubmission(page, settings, selected, {}, progress => {
            if (progress.submitAttempted && !beforeClick) beforeClick = submissionCounts(page);
        });
        assert.equal((await beforeClick)!.orderClicks, 0);
        assert.equal(result.outcome, "rejected");
        assert.equal(result.progress.dismissal, "confirmed");
        assert.deepEqual(await submissionCounts(page), {
            orderClicks: 1,
            dismissClicks: 1,
            infoClicks: 0,
            otherClicks: 0,
            termsChanges: 0,
        });
    } finally {
        await browser.close();
    }
});

test("TicketPlus 結果：同步通知耗時不可讓提交、排隊或關閉期限重設", async () => {
    for (const mode of ["direct", "queue", "failure"] as const) {
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage();
            await installSubmission(page, mode);
            let blocked = false;
            const result = await runTicketPlusSubmission(
                page,
                settings,
                selected,
                {
                    submitWaitMs: mode === "direct" ? 100 : 2_000,
                    queueWaitMs: 100,
                    closeTimeoutMs: 100,
                },
                progress => {
                    const boundary =
                        mode === "direct"
                            ? progress.submitAttempted
                            : mode === "queue"
                              ? progress.sawQueue
                              : Boolean(progress.failure);
                    if (!boundary || blocked) return;
                    blocked = true;
                    const end = performance.now() + 160;
                    while (performance.now() < end) {
                        /* 模擬同步通知耗時。 */
                    }
                },
            );
            assert(blocked);
            assert.equal(result.outcome, mode === "failure" ? "rejected" : "unknown");
            const counts = await submissionCounts(page);
            assert.equal(counts.orderClicks, mode === "direct" ? 0 : 1);
            assert.equal(counts.dismissClicks, 0);
        } finally {
            await browser.close();
        }
    }
});
