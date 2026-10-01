import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { FlowPause } from "../src/core/flowPause.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { SeatExpiredBeforeConfirmationError } from "../src/core/seatExpiry.js";

function terminal() {
    return { input: Object.assign(new PassThrough(), { isTTY: true }), output: new PassThrough() };
}
function recovery() {
    return { expired: false, count: 0,
        async isRequired() { return this.expired; },
        async recover() { this.expired = false; this.count++; },
    };
}

test("停用時不讀輸入；拒絕錯誤參數與非互動終端", async () => {
    const input = new PassThrough();
    assert.equal(await new FlowPause(undefined, input).waitAt("seats"), false);
    assert.throws(() => new FlowPause("typo", input), /只能設定/);
    assert.throws(() => new FlowPause("seats", input), /互動/);
    assert.equal(input.listenerCount("data"), 0);
});

test("只在指定位置等待 Enter，而且整次執行只停一次", async () => {
    const { input, output } = terminal();
    const pause = new FlowPause("contact", input, output);
    assert.equal(await pause.waitAt("seats"), false);
    let completed = false;
    const waiting = pause.waitAt("contact").then(result => { completed = true; return result; });
    input.write("hello\n");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    input.write("\n");
    assert.equal(await waiting, true);
    assert.equal(await pause.waitAt("contact"), false);
    assert.equal(input.listenerCount("keypress"), 0);
    assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount("error"), 0);
});

test("選位與個資暫停後過期走既有恢復，新的一輪不再次暫停", async () => {
    for (const point of ["seats", "contact"] as const) {
        const { input, output } = terminal();
        const pause = new FlowPause(point, input, output);
        const queue = recovery(), seats = recovery(), contact = recovery();
        let attempts = 0, confirmations = 0, pauses = 0;
        const selected = point === "seats" ? seats : contact;
        async function checkpoint(at: "seats" | "contact") {
            const waiting = pause.waitAt(at);
            if (at === point && attempts === 1) {
                selected.expired = true;
                input.write("\n");
            }
            if (await waiting) pauses++;
        }
        await prepareBooking({
            selectSeats: async () => ++attempts,
            confirmSeats: async () => {
                await checkpoint("seats");
                if (seats.expired) throw new SeatExpiredBeforeConfirmationError();
                confirmations++;
            },
            prepareContact: async () => { await checkpoint("contact"); },
        }, queue, contact, seats);
        assert.equal(attempts, 2);
        assert.equal(pauses, 1);
        assert.equal(selected.count, 1);
        assert.equal(confirmations, point === "seats" ? 1 : 2);
    }
});

test("未過期就繼續，不強制恢復", async () => {
    const { input, output } = terminal();
    const pause = new FlowPause("contact", input, output);
    const contact = recovery();
    let attempts = 0;
    await prepareBooking({
        selectSeats: async () => ++attempts,
        confirmSeats: async () => {},
        prepareContact: async () => {
            const waiting = pause.waitAt("contact");
            input.write("\n");
            await waiting;
        },
    }, recovery(), contact, recovery());
    assert.equal(attempts, 1);
    assert.equal(contact.count, 0);
});

test("Ctrl+C 或輸入關閉立即取消，即使個資已過期也不重跑", async () => {
    for (const action of ["interrupt", "close"] as const) {
        const { input, output } = terminal();
        const pause = new FlowPause("contact", input, output);
        const contact = recovery();
        let attempts = 0;
        await assert.rejects(prepareBooking({
            selectSeats: async () => ++attempts,
            confirmSeats: async () => {},
            prepareContact: async () => {
                const waiting = pause.waitAt("contact");
                contact.expired = true;
                if (action === "interrupt") input.write("\u0003");
                else input.end();
                await waiting;
            },
        }, recovery(), contact), { name: "AbortError" });
        assert.equal(attempts, 1);
        assert.equal(contact.count, 0);
        assert.equal(input.listenerCount("error"), 0);
    }
});
