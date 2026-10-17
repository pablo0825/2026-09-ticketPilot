import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { getEventListeners } from "node:events";
import { chromium } from "playwright";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import { selectTicketPlusTickets } from "../src/platforms/ticketplus/ticketQuantity.js";
import { selectTicketPlusPriority } from "../src/platforms/ticketplus/ticketPriority.js";
import { selectTicketPlusSession } from "../src/platforms/ticketplus/sessionSelection.js";
import { runTicketPlusSubmission } from "../src/platforms/ticketplus/submissionOutcome.js";
import { installQuantityFixture, quantityState } from "./fixtures/ticketplus/quantityPage.js";
import { installSubmission, submissionCounts } from "./fixtures/ticketplus/submissionPage.js";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import type { TicketSelectionPage } from "../src/platforms/ticketplus/ticketSelectionPage.js";

const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
const identity = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
};
const selection: TicketSelectionPage = {
    kind: "ticket-selection",
    ...identity,
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
const submissionOptions = { totalTimeoutMs: 5000, clickTimeoutMs: 1000, pollIntervalMs: 20 };
const zero = { orderClicks: 0, dismissClicks: 0, infoClicks: 0, otherClicks: 0, termsChanges: 0 };

function latch() {
    let resolve!: () => void;
    const promise = new Promise<void>(value => {
        resolve = value;
    });
    return { promise, resolve };
}

test("停止控制：唯讀與等待取消後清理監聽；外部原因不進錯誤", async () => {
    const controller = new AbortController();
    const control = new TicketPlusRunControl(controller.signal);
    const gate = latch();
    const entered = latch();
    const read = control.read(() => {
        entered.resolve();
        return gate.promise;
    });
    const waiting = control.wait(60_000);
    const rejected = Promise.all([
        assert.rejects(read, TicketPlusStopError),
        assert.rejects(waiting, TicketPlusStopError),
    ]);
    await entered.promise;
    controller.abort("PRIVATE_REASON");
    await rejected;
    gate.resolve();
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.throws(
        () => control.check(),
        error => error instanceof TicketPlusStopError && !error.message.includes("PRIVATE"),
    );
});

test("停止控制：預先停止時場次／順位／張數／提交均不操作", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page);
        const controller = new AbortController();
        controller.abort();
        const control = new TicketPlusRunControl(controller.signal);
        await assert.rejects(selectTicketPlusSession(page, settings, {}, control), TicketPlusStopError);
        const { target, ...event } = settings;
        await assert.rejects(
            selectTicketPlusPriority(page, { ...event, targets: [target] }, identity, {}, control),
            TicketPlusStopError,
        );
        await assert.rejects(selectTicketPlusTickets(page, settings, identity, {}, control), TicketPlusStopError);
        const result = await runTicketPlusSubmission(page, settings, selection, {}, undefined, control);
        assert.equal(result.outcome, "stopped");
        assert.equal(result.stopReason, "user-stop");
        assert.equal(result.progress.submitAttempted, false);
        assert(Object.values((await quantityState(page)).clicks).every(value => value === 0));
    } finally {
        await browser.close();
    }
});

test("停止控制：加票等待更新中取消，延遲更新不能再觸發加票或提交", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { behavior: "delayed" });
        const controller = new AbortController();
        const pending = selectTicketPlusTickets(
            page,
            settings,
            identity,
            {},
            new TicketPlusRunControl(controller.signal),
        );
        const rejected = assert.rejects(pending, TicketPlusStopError);
        await page.waitForFunction(() => window.quantityFixture.pending);
        controller.abort();
        await rejected;
        await page.evaluate(() => window.quantityFixture.acknowledge());
        await new Promise(resolve => setTimeout(resolve, 150));
        const state = await quantityState(page);
        assert.equal(state.counts.presale, "1");
        assert.deepEqual(state.clicks, {
            studentPlus: 0,
            studentMinus: 0,
            presalePlus: 1,
            presaleMinus: 0,
            next: 0,
            refresh: 0,
            other: 0,
        });
    } finally {
        await browser.close();
    }
});

test("停止控制：排隊／失敗彈窗停止保留提交事實；已成功結果不被晚到停止覆寫", { timeout: 15_000 }, async () => {
    const browser = await chromium.launch();
    try {
        for (const mode of ["queue", "failure", "direct"] as const) {
            const page = await browser.newPage();
            await installSubmission(page, mode);
            const controller = new AbortController();
            const result = await runTicketPlusSubmission(
                page,
                settings,
                selection,
                submissionOptions,
                progress => {
                    if (progress.sawQueue || progress.failure) controller.abort();
                },
                new TicketPlusRunControl(controller.signal),
            );
            controller.abort();
            assert.equal(
                result.outcome,
                mode === "queue" ? "unknown" : mode === "failure" ? "rejected" : "information-ready",
            );
            assert.equal(result.progress.submitAttempted, true);
            assert.equal(result.stopReason, mode === "direct" ? undefined : "user-stop");
            if (mode === "failure") {
                assert.equal(result.progress.failure, "sold-out");
                assert.equal(result.progress.dismissal, "not-attempted");
                assert.equal(result.progress.dismissAttempted, false);
            }
            if (mode === "queue") await page.evaluate(() => window.submissionFixture.show("information"));
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("停止控制：在途提交點擊須收尾；停止完成後解除遮罩無遲到點擊", { timeout: 15_000 }, async () => {
    const browser = await chromium.launch();
    try {
        for (const allowClick of [false, true]) {
            const page = await browser.newPage();
            await installSubmission(page, "stay");
            await page.evaluate(() =>
                document.body.insertAdjacentHTML(
                    "beforeend",
                    '<div id="cover" style="position:fixed;inset:0;z-index:999;background:white"></div>',
                ),
            );
            const handle = await page.locator("#cover").elementHandle();
            const prototype = Object.getPrototypeOf(handle!);
            const click = prototype.click;
            const entered = latch();
            const hook = mock.method(prototype, "click", function (this: any, ...args: any[]) {
                const promise = click.apply(this, args);
                entered.resolve();
                return promise;
            });
            const controller = new AbortController();
            let settled = false;
            const pending = runTicketPlusSubmission(
                page,
                settings,
                selection,
                submissionOptions,
                undefined,
                new TicketPlusRunControl(controller.signal),
            ).then(result => {
                settled = true;
                return result;
            });
            try {
                await entered.promise;
                controller.abort();
                await page.evaluate(() => Boolean(document.querySelector("#cover")));
                assert.equal(settled, false, "不能拋下尚在執行的click就宣告停止完成");
                if (allowClick) await page.locator("#cover").evaluate(element => element.remove());
                const result = await pending;
                assert.equal(result.outcome, "unknown");
                assert.equal(result.stopReason, "user-stop");
                assert.equal(result.progress.submitAttempted, true);
                if (!allowClick) await page.locator("#cover").evaluate(element => element.remove());
                await new Promise(resolve => setTimeout(resolve, 150));
                assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: allowClick ? 1 : 0 });
            } finally {
                hook.mock.restore();
                await handle?.dispose();
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});

test("停止控制：選場次到達等待與順位唯讀取消後均不續行", { timeout: 10_000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        // 固定活動頁按鈕只計數，故場次操作會停在等待到達選票頁。
        const { activity } = await import("./fixtures/ticketplus/pages.js");
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: activity }));
        await page.goto(settings.eventUrl);
        await page.evaluate(() => {
            (window as any).clicks = 0;
            document.addEventListener("click", () => {
                (window as any).clicks++;
            });
        });
        const controller = new AbortController();
        const pending = selectTicketPlusSession(page, settings, {}, new TicketPlusRunControl(controller.signal));
        const stopped = assert.rejects(pending, TicketPlusStopError);
        await page.waitForFunction(() => (window as any).clicks === 1);
        controller.abort();
        await stopped;
        assert.equal(await page.evaluate(() => (window as any).clicks), 1);

        // 順位讀取取消後才交回真快照，不能進入張數模組。
        await installQuantityFixture(page);
        const gate = latch();
        const entered = latch();
        const evaluate = page.evaluate.bind(page);
        const hook = mock.method(page, "evaluate", async (...args: any[]) => {
            const result = await (evaluate as any)(...args);
            entered.resolve();
            await gate.promise;
            return result;
        });
        const nextController = new AbortController();
        try {
            const { target, ...event } = settings;
            const selecting = selectTicketPlusPriority(
                page,
                { ...event, targets: [target] },
                identity,
                {},
                new TicketPlusRunControl(nextController.signal),
            );
            const rejected = assert.rejects(selecting, TicketPlusStopError);
            await entered.promise;
            nextController.abort();
            await rejected;
        } finally {
            gate.resolve();
            hook.mock.restore();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(Object.values((await quantityState(page)).clicks).every(value => value === 0));
    } finally {
        await browser.close();
    }
});
