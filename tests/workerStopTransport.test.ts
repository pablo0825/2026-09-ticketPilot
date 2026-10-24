import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { sendWorkerStop } from "../src/local/sendWorkerStop.js";
import { ticketPlusDefinition } from "../src/app/platforms/ticketPlus.js";

// 僅替代 IPC 邊界，實際停止購票另由 API 與正式 worker 的整合測試驗證。
function childFixture(mode: "accepted" | "backpressure" | "throw" | "callback-error" = "accepted") {
    const messages: unknown[] = [];
    let callback: (error?: Error | null) => void = () => {};
    const child = Object.assign(new EventEmitter(), {
        connected: true,
        send(message: unknown, done: typeof callback) {
            messages.push(message);
            callback = done;
            if (mode === "throw") throw new Error("PRIVATE_IPC_ERROR");
            if (mode === "callback-error") done(new Error("PRIVATE_IPC_ERROR"));
            return mode !== "backpressure";
        },
    });
    return { child, messages, complete: (error?: Error | null) => callback(error) };
}

function assertListenersRemoved(child: EventEmitter): void {
    for (const event of ["disconnect", "exit", "error"]) {
        assert.equal(child.listenerCount(event), 0, `${event} listener should be removed`);
    }
}

test("停止 IPC：send 的布林回傳不代表送達，必須等待回呼且不因背壓重送", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const mode of ["accepted", "backpressure"] as const) {
        // 先確認傳送仍在等待，而非只驗證最終成功。
        const fixture = childFixture(mode);
        let settled = false;
        const pending = sendWorkerStop(fixture.child as unknown as ChildProcess, { type: "stop-fixture" }).then(() => {
            settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false);
        assert.deepEqual(fixture.messages, [{ type: "stop-fixture" }]);

        // 成功後清理監聽，稍後到期或重複回呼不會改變結果。
        fixture.complete(null);
        await pending;
        assert.equal(settled, true);
        assertListenersRemoved(fixture.child);
        t.mock.timers.tick(5_000);
        fixture.complete(new Error("PRIVATE_IPC_ERROR"));
        assert.equal(fixture.messages.length, 1);
    }
});

test("停止 IPC：傳送故障、失聯與期限都只回報未確認，不重送或泄漏原始錯誤", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const fault of ["throw", "callback-error", "disconnect", "exit", "error", "timeout"] as const) {
        // 掛上拒絕檢查後才觸發故障，避免未處理的 Promise 拒絕。
        const fixture = childFixture(fault === "throw" || fault === "callback-error" ? fault : "accepted");
        const checked = assert.rejects(
            sendWorkerStop(fixture.child as unknown as ChildProcess, { type: "stop-fixture" }),
            error => {
                assert(error instanceof Error);
                assert.match(error.message, /未確認/);
                assert.doesNotMatch(error.message, /PRIVATE_IPC_ERROR/);
                return true;
            },
        );

        // 覆蓋真正的通道事件與沒有回呼的期限，而非直接假造拒絕結果。
        if (fault === "disconnect" || fault === "exit" || fault === "error") {
            fixture.child.emit(fault, new Error("PRIVATE_IPC_ERROR"));
        }
        if (fault === "timeout") t.mock.timers.tick(5_000);
        await checked;
        assertListenersRemoved(fixture.child);

        // 晚到成功不能翻轉失敗，也不能引發第二次傳送。
        fixture.complete(null);
        t.mock.timers.tick(5_000);
        assert.equal(fixture.messages.length, 1);
        assertListenersRemoved(fixture.child);
    }
});

test("停止 IPC：已斷線時不呼叫 send，也不留下監聽", async () => {
    const fixture = childFixture();
    fixture.child.connected = false;
    await assert.rejects(sendWorkerStop(fixture.child as unknown as ChildProcess, { type: "stop-fixture" }));
    assert.equal(fixture.messages.length, 0);
    assertListenersRemoved(fixture.child);
});

test("TicketPlus 定義提供既有停止訊息", () => {
    assert.deepEqual(ticketPlusDefinition.stop?.message, { type: "stop-ticketplus" });
});
