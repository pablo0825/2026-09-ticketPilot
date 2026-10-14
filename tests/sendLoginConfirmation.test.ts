import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { sendLoginConfirmation } from "../src/local/sendLoginConfirmation.js";

// 只測 IPC 邊界故障；購票成功另以正式 worker 的 API 整合測試驗證。
function childFixture(mode: "backpressure" | "throw" | "error" | "silent") {
    let calls = 0;
    let callback: (error?: Error | null) => void = () => {};
    const child = Object.assign(new EventEmitter(), {
        connected: true,
        send(message: unknown, done: typeof callback) {
            calls++;
            assert.deepEqual(message, { type: "confirm-ticketplus-login", confirmationId: "fixture-id" });
            callback = done;
            if (mode === "throw") throw new Error("PRIVATE_ERROR");
            if (mode === "error") done(new Error("PRIVATE_ERROR"));
            return false;
        },
    });
    return { child, calls: () => calls, complete: () => callback(null) };
}

test("登入 IPC：false 背壓不當成失敗，回呼成功只表示送出，完成後清理監聽", async () => {
    const f = childFixture("backpressure");
    const pending = sendLoginConfirmation(f.child as unknown as ChildProcess, "fixture-id");
    f.complete();
    await pending;
    assert.equal(f.calls(), 1);
    assert.equal(f.child.listenerCount("disconnect"), 0);
    assert.equal(f.child.listenerCount("exit"), 0);
    assert.equal(f.child.listenerCount("error"), 0);
});

test("登入 IPC：同步錯誤、回呼錯誤、失聯與逾時都不重送且不泄漏原始錯誤", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const mode of ["throw", "error", "disconnect", "timeout"] as const) {
        const f = childFixture(mode === "throw" || mode === "error" ? mode : "silent");
        const checked = assert.rejects(
            sendLoginConfirmation(f.child as unknown as ChildProcess, "fixture-id"),
            error => {
                assert(error instanceof Error);
                assert.match(error.message, /未確認.*不會自動重送/);
                assert.doesNotMatch(error.message, /PRIVATE_ERROR/);
                return true;
            },
        );
        if (mode === "disconnect") f.child.emit("disconnect");
        if (mode === "timeout") t.mock.timers.tick(5_000);
        await checked;
        f.complete(); // 晚到的成功回呼不能翻轉已完成結果。
        assert.equal(f.calls(), 1);
        assert.equal(f.child.listenerCount("disconnect"), 0);
        assert.equal(f.child.listenerCount("error"), 0);
    }
});
