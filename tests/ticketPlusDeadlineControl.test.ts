import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";

const isTimeLimit = (error: unknown) => error instanceof TicketPlusStopError && error.stopReason === "time-limit";

test("全程期限只啟動一次，登入前時間不計入且無設定保留原行為", () => {
    let now = 0;
    const control = new TicketPlusRunControl(undefined, () => now);
    now = 300_000;
    assert.equal(control.remainingMs(), Infinity);
    control.startDeadline(1);
    now += 40_000;
    assert.equal(control.remainingMs(), 20_000);
    assert.throws(() => control.startDeadline(1), /已啟動/);
    now += 20_000;
    assert.throws(() => control.check(), isTimeLimit);
    const unlimited = new TicketPlusRunControl(undefined, () => now);
    unlimited.startDeadline();
    now += 100_000_000;
    assert.equal(unlimited.remainingMs(), Infinity);
});

test("沒有手動停止訊號也能以期限喚醒讀取與等待", async () => {
    for (const mode of ["read", "wait"] as const) {
        let offset = 0;
        const control = new TicketPlusRunControl(undefined, () => performance.now() + offset);
        control.startDeadline(1);
        offset = 59_980;
        const started = performance.now();
        const work = mode === "read" ? control.read(() => new Promise<void>(() => {})) : control.wait(60_000);
        await assert.rejects(work, isTimeLimit);
        assert.ok(performance.now() - started < 2_000);
    }
});

test("首個觀察到的停止原因保留，外部原因不外洩且監聽清除", async () => {
    const abort = new AbortController();
    let now = 0;
    const control = new TicketPlusRunControl(abort.signal, () => now);
    control.startDeadline(1);
    now = 60_000;
    assert.throws(() => control.check(), isTimeLimit);
    abort.abort("private data");
    assert.throws(() => control.check(), isTimeLimit);

    const manual = new AbortController();
    const manualControl = new TicketPlusRunControl(manual.signal, () => now);
    manualControl.startDeadline(1);
    const pending = manualControl.wait(60_000);
    manual.abort("private data");
    await assert.rejects(
        pending,
        error =>
            error instanceof TicketPlusStopError &&
            error.stopReason === "user-stop" &&
            !error.message.includes("private"),
    );
    now += 60_000;
    assert.throws(
        () => manualControl.check(),
        error => error instanceof TicketPlusStopError && error.stopReason === "user-stop",
    );
    assert.equal(getEventListeners(manual.signal, "abort").length, 0);
});

test("剩餘不足一毫秒時，順位與張數讀取不會把全程期限誤報為局部逾時", async () => {
    const { selectTicketPlusPriority } = await import("../src/platforms/ticketplus/ticketPriority.js");
    const { selectTicketPlusTickets } = await import("../src/platforms/ticketplus/ticketQuantity.js");
    const target = { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 };
    const selection = {
        platform: "ticketplus" as const,
        eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
        eventName: "測試活動",
        target,
    };
    const session = {
        eventId: "event-fixture",
        sessionId: "session-B",
        eventName: selection.eventName,
        date: target.date,
        time: target.time,
    };
    for (const kind of ["priority", "quantity"] as const) {
        // 固定在期限前半毫秒，讓真實計時器先觸發；唯讀工作刻意尚未完成。
        let now = 0;
        let reads = 0;
        const control = new TicketPlusRunControl(undefined, () => now);
        control.startDeadline(1);
        now = 59_999.5;
        const page = {
            url: () => "https://ticketplus.com.tw/order/event-fixture/session-B",
            evaluate: () => {
                reads++;
                return new Promise(() => {});
            },
        } as unknown as import("playwright").Page;
        let settled = false;
        const work =
            kind === "priority"
                ? selectTicketPlusPriority(
                      page,
                      {
                          platform: selection.platform,
                          eventUrl: selection.eventUrl,
                          eventName: selection.eventName,
                          targets: [target],
                      },
                      session,
                      {},
                      control,
                  )
                : selectTicketPlusTickets(page, selection, session, {}, control);
        const checked = assert.rejects(work, isTimeLimit).finally(() => {
            settled = true;
        });
        try {
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(reads, 1);
            assert.equal(settled, false, "全程期限尚未到，不應先回報局部讀取逾時");
        } finally {
            now = 60_000;
            await checked;
        }

        // 全程尚餘一分鐘時，原本較短的局部期限仍必須先結束。
        const longControl = new TicketPlusRunControl(undefined, () => 0);
        longControl.startDeadline(1);
        const localWork =
            kind === "priority"
                ? selectTicketPlusPriority(
                      page,
                      {
                          platform: selection.platform,
                          eventUrl: selection.eventUrl,
                          eventName: selection.eventName,
                          targets: [target],
                      },
                      session,
                      { timeoutMs: 20 },
                      longControl,
                  )
                : selectTicketPlusTickets(page, selection, session, { timeoutMs: 20 }, longControl);
        await assert.rejects(localWork, error => {
            assert.ok(error instanceof Error);
            assert.equal((error as { reason?: string }).reason, "operation-timeout");
            assert.equal((error as { stopReason?: string }).stopReason, undefined);
            return true;
        });
    }
});

test("排除期限的等待：期間不計時，結束後以剩餘時間繼續；期間停止仍立即生效", async () => {
    let now = 0;
    const control = new TicketPlusRunControl(undefined, () => now);
    control.startDeadline(1);
    now = 20_000;
    await control.excludeFromDeadline(async () => {
        now = 500_000;
        control.check();
    });
    assert.equal(control.remainingMs(), 40_000);

    const abort = new AbortController();
    const stoppable = new TicketPlusRunControl(abort.signal, () => now);
    stoppable.startDeadline(1);
    await assert.rejects(
        stoppable.excludeFromDeadline(async () => {
            abort.abort();
            await stoppable.wait(10);
        }),
        (error: unknown) => error instanceof TicketPlusStopError && error.stopReason === "user-stop",
    );
});
