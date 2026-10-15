import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { getEventListeners } from "node:events";
import type { Page } from "playwright";
import { waitForTicketPlusSale } from "../src/platforms/ticketplus/saleWait.js";
import { TicketPlusRunControl, TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";

const saleAt = "2026-10-30T12:00:00+08:00";
const target = Date.parse(saleAt);
function pageFixture() {
    const emitter = new EventEmitter();
    const page = Object.assign(emitter, { isClosed: () => false });
    return { page: page as unknown as Page, emitter };
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("開賣等待：過時立即完成，停止與關閉優先於到點", async () => {
    const { page, emitter } = pageFixture();
    await waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(), () => target + 1);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
        waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(abort.signal), () => target),
        TicketPlusStopError,
    );
    page.isClosed = () => true;
    await assert.rejects(
        waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(), () => target),
        /關閉/,
    );
    assert.equal(emitter.listenerCount("close"), 0);
    assert.equal(emitter.listenerCount("crash"), 0);
});

test("開賣等待：遠期時間不溢位，時鐘倒退不能提前完成，前進到點才完成", async () => {
    const { page, emitter } = pageFixture();
    let now = target - 365 * 24 * 3600_000;
    let finished = false;
    const waiting = waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(), () => now).then(() => {
        finished = true;
    });
    await delay(300);
    assert.equal(finished, false);
    now -= 1000;
    await delay(300);
    assert.equal(finished, false);
    now = target;
    await waiting;
    assert.equal(finished, true);
    assert.equal(emitter.listenerCount("close"), 0);
    assert.equal(emitter.listenerCount("crash"), 0);
});

test("開賣等待：取消、close、crash 清理監聽，不留下後續輪詢", async () => {
    for (const action of ["abort", "close", "crash"] as const) {
        const { page, emitter } = pageFixture();
        const abort = new AbortController();
        let reads = 0;
        const waiting = waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(abort.signal), () => {
            reads++;
            return target - 3600_000;
        });
        const rejected = assert.rejects(waiting, action === "abort" ? TicketPlusStopError : /關閉|中斷/);
        if (action === "abort") abort.abort();
        else emitter.emit(action);
        await rejected;
        const readsAtStop = reads;
        await delay(300);
        assert.equal(reads, readsAtStop);
        assert.equal(emitter.listenerCount("close"), 0);
        assert.equal(emitter.listenerCount("crash"), 0);
        assert.equal(getEventListeners(abort.signal, "abort").length, 0);
    }
});

test("開賣等待：無效時鐘與日期拒絕而非開始選票", async () => {
    const { page, emitter } = pageFixture();
    await assert.rejects(
        waitForTicketPlusSale(page, saleAt, new TicketPlusRunControl(), () => NaN),
        /核對/,
    );
    await assert.rejects(waitForTicketPlusSale(page, "2026-02-30T12:00:00+08:00", new TicketPlusRunControl()));
    assert.equal(emitter.listenerCount("close"), 0);
});
