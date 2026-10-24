import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, mkdir, rmdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ChildProcess } from "node:child_process";
import { apiHarness, apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { PurchaseRuns } from "../src/server/runs/purchaseRuns.js";
import { purchaseOccupied } from "../src/storage/purchaseLock.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
async function launch(h: Harness) {
    const saved = await (await h.request("/api/activities", apiActivity)).json();
    const response = await h.request("/api/purchase", {
        requestId: randomUUID(),
        activityId: saved.id,
        expectedActivity: apiActivity,
    });
    assert.equal(response.status, 200);
    return response.json();
}
async function login(h: Harness) {
    const waiting = await h.until(run =>
        Boolean(run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login")),
    );
    assert.equal(waiting.loginConfirmation, undefined);
    await h.login();
}
async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("fixture condition timed out");
}

test("停止 API：登入等待可停止，並行重送不重複 IPC、資格失效且關窗前保留占用", async t => {
    const h = await apiHarness();
    const originalEmit = ChildProcess.prototype.emit;
    let worker: ChildProcess | undefined;
    let stops = 0;
    try {
        t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: any[]) {
            if (event === "message" && args[0]?.event?.stage === "waiting-for-login") worker = this;
            return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        await launch(h);
        const waiting = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        assert(worker);
        const originalSend = worker.send;
        t.mock.method(worker, "send", function (this: ChildProcess, message: any, ...args: any[]) {
            if (message?.type === "stop-ticketplus") stops++;
            return Reflect.apply(originalSend, this, [message, ...args]);
        });
        const responses = await Promise.all([
            h.request("/api/purchase/stop", { runId: waiting.id }),
            h.request("/api/purchase/stop", { runId: waiting.id }),
        ]);
        assert(responses.every(response => response.status === 200));
        assert.equal(stops, 1);
        const finished = await h.until(run => run?.status === "failed");
        assert.match(finished.message, /停止/);
        assert.equal(finished.loginConfirmation, undefined);
        assert.equal(finished.canStop, false);
        assert.equal(finished.canCloseBrowser, true);
        assert.equal(finished.occupied, true);
        assert(purchaseOccupied(h.runtime));
        assert.equal(
            (
                await h.request("/api/purchase/confirm-login", {
                    runId: waiting.id,
                    confirmationId: randomUUID(),
                })
            ).status,
            400,
        );
        assert.deepEqual((await h.counts()).counts, {
            session: 0,
            plus: 0,
            submit: 0,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        assert.equal((await h.request("/api/purchase/close-browser", { runId: waiting.id })).status, 200);
        await h.until(run => !run?.occupied);
        // 即使歷史檔案帶有偽造的即時能力，重啟也不能恢復 worker 控制權。
        const files = await readdir(join(h.runtime, "runs"));
        const file = join(h.runtime, "runs", files[0]!);
        const stored = JSON.parse(await readFile(file, "utf8"));
        Object.assign(stored.snapshot, {
            canStop: true,
            canCloseBrowser: true,
            stopRequest: { status: "sending" },
            loginConfirmation: { confirmationId: randomUUID() },
        });
        await writeFile(file, JSON.stringify(stored));
        const restored = new PurchaseRuns(h.runtime);
        assert.equal(restored.snapshot()!.canStop, false);
        assert.equal(restored.snapshot()!.canCloseBrowser, false);
        assert.equal(restored.snapshot()!.stopRequest, undefined);
        assert.equal(restored.snapshot()!.loginConfirmation, undefined);
        await assert.rejects(restored.stop(waiting.id));
    } finally {
        t.mock.restoreAll();
        await h.dispose();
    }
});

test("停止 API：啟動瀏覽器途中可停止，等待 launch 收尾而不提前釋放占用", async () => {
    const h = await apiHarness("held-launch");
    try {
        const run = await launch(h);
        await waitFor(async () => Boolean(await readFile(h.report + ".options", "utf8").catch(() => "")));
        assert.equal((await h.request("/api/purchase/stop", { runId: run.id })).status, 200);
        const pending = (await h.snapshot())!;
        assert.equal(pending.status, "running");
        assert.equal(pending.occupied, true);
        const feed = await fetch(h.url + `/api/purchase/events?token=${h.token}`);
        const reader = feed.body!.getReader();
        try {
            const text = new TextDecoder().decode((await reader.read()).value);
            const streamed = JSON.parse(text.slice("data: ".length).trim());
            assert.deepEqual(streamed.stopRequest, pending.stopRequest);
            assert.equal(streamed.canStop, false);
            assert.equal(streamed.status, "running");
        } finally {
            await reader.cancel();
        }
        await writeFile(h.report + ".control", "release-launch");
        const finished = await h.until(run => run?.status === "failed");
        assert.equal(finished.browserOpen, true);
        assert(purchaseOccupied(h.runtime));
        assert.equal(finished.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
        await h.until(run => !run?.occupied);
    } finally {
        await h.dispose();
    }
});

test("停止 API：加第一張後停止，解除延遲也不再加票或提交", async () => {
    const h = await apiHarness("held-plus");
    try {
        const run = await launch(h);
        await login(h);
        await waitFor(async () => (await h.counts()).counts.plus === 1);
        assert.equal((await h.request("/api/purchase/stop", { runId: run.id })).status, 200);
        await h.until(run => run?.status === "failed");
        await writeFile(h.report + ".control", "release-plus");
        await waitFor(async () => (await readFile(h.report + ".released", "utf8").catch(() => "")) === "yes");
        const counts = (await h.counts()).counts;
        assert.equal(counts.plus, 1);
        assert.equal(counts.submit, 0);
        assert.equal(counts.session, 1);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
    } finally {
        await h.dispose();
    }
});

test("停止 API：排隊停止仍是 unknown，已提交一次且不重送", async () => {
    const h = await apiHarness("queue");
    try {
        const run = await launch(h);
        await login(h);
        await waitFor(async () => (await h.counts()).counts.submit === 1);
        assert.equal((await h.request("/api/purchase/stop", { runId: run.id })).status, 200);
        const finished = await h.until(run => run?.status === "unknown");
        assert.match(finished.message, /停止/);
        assert.equal(finished.canCloseBrowser, true);
        assert.equal((await h.counts()).counts.submit, 1);
        assert.equal((await h.counts()).counts.information, 0);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
    } finally {
        await h.dispose();
    }
});

test("停止 API：錯誤 ID、額外欄位、缺 token 及跨來源不影響登入資格", async () => {
    const h = await apiHarness();
    try {
        assert.equal((await h.request("/api/purchase/stop", { runId: "old" })).status, 400);
        await launch(h);
        const waiting = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        for (const body of [{ runId: "old" }, { runId: waiting.id, extra: true }]) {
            assert.equal((await h.request("/api/purchase/stop", body)).status, 400);
        }
        for (const headers of [
            { "Content-Type": "application/json" },
            { ...h.headers, Origin: "https://other.example" },
        ]) {
            assert.equal(
                (
                    await fetch(h.url + "/api/purchase/stop", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ runId: waiting.id }),
                    })
                ).status,
                403,
            );
        }
        assert.equal((await h.snapshot())!.loginConfirmation, undefined);
        assert.equal((await h.counts()).counts.session, 0);
        await login(h);
        const finished = await h.until(run => run?.status === "payment-ready");
        assert.equal((await h.request("/api/purchase/stop", { runId: waiting.id })).status, 400);
        assert.equal((await h.snapshot())!.status, "payment-ready");
        assert.equal((await h.request("/api/purchase/close-browser", { runId: finished.id })).status, 200);
    } finally {
        await h.dispose();
    }
});

test("停止 API：IPC 傳送失敗保留未確認，晚到登入事件不恢復資格也不重送", async t => {
    const h = await apiHarness();
    const originalEmit = ChildProcess.prototype.emit;
    let worker: ChildProcess | undefined;
    let stops = 0;
    try {
        t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: any[]) {
            if (event === "message" && args[0]?.event?.stage === "waiting-for-login") worker = this;
            return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        await launch(h);
        const waiting = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        assert(worker);
        const originalSend = worker.send;
        // 只讓 IPC 傳送失敗，API、事件處理與真實 worker 均繼續執行。
        t.mock.method(worker, "send", function (this: ChildProcess, message: any, ...args: any[]) {
            if (message?.type !== "stop-ticketplus") return Reflect.apply(originalSend, this, [message, ...args]);
            stops++;
            args.at(-1)(new Error("PRIVATE_IPC_DETAIL"));
            this.emit("message", {
                type: "event",
                event: {
                    type: "ticketplus",
                    stage: "login-ready",
                    confirmationId: randomUUID(),
                },
            });
            return false;
        });
        const response = await h.request("/api/purchase/stop", { runId: waiting.id });
        const result = await response.json();
        assert.equal(response.status, 200);
        assert.equal(result.status, "unconfirmed");
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_IPC_DETAIL/);
        assert.equal((await h.snapshot())!.status, "running");
        assert.equal((await h.snapshot())!.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/stop", { runId: waiting.id })).status, 200);
        assert.equal(stops, 1);
        assert.equal((await h.counts()).counts.session, 0);
    } finally {
        t.mock.restoreAll();
        await h.dispose();
    }
});

test("停止 API：最終紀錄暫時無法寫入也先傳送停止要求", async () => {
    const h = await apiHarness("held-launch");
    try {
        const run = await launch(h);
        await waitFor(async () => Boolean(await readFile(h.report + ".options", "utf8").catch(() => "")));
        // 用目錄阻擋原子寫入；launch 尚未完成，因此不會碰到最終結果保存。
        const files = await readdir(join(h.runtime, "runs"));
        assert.equal(files.length, 1);
        const file = join(h.runtime, "runs", files[0]!);
        await rename(file, file + ".backup");
        await mkdir(file);
        const response = await h.request("/api/purchase/stop", { runId: run.id });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "sent");
        assert.equal((await h.snapshot())!.status, "running");
        // 還原儲存後才讓 launch 完成，確認真正的 worker 已收到停止。
        await rmdir(file);
        await rename(file + ".backup", file);
        await writeFile(h.report + ".control", "release-launch");
        const finished = await h.until(run => run?.status === "failed");
        assert.match(finished.message, /停止/);
        assert.equal(finished.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
    } finally {
        await h.dispose();
    }
});

test("停止 API：停止傳送回呼晚於成功結果，不覆蓋資料頁終局", async t => {
    const h = await apiHarness("queue");
    const originalEmit = ChildProcess.prototype.emit;
    let worker: ChildProcess | undefined;
    let sent: (() => void) | undefined;
    let response: Promise<Response> | undefined;
    try {
        t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: any[]) {
            if (event === "message" && args[0]?.event?.stage === "waiting-for-login") worker = this;
            return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        const run = await launch(h);
        await login(h);
        await waitFor(async () => (await h.counts()).counts.submit === 1);
        assert(worker);
        const originalSend = worker.send;
        // 延遲傳送完成通知；runner 仍讀取真實頁面，沒有假造成功結果。
        t.mock.method(worker, "send", function (this: ChildProcess, message: any, ...args: any[]) {
            if (message?.type !== "stop-ticketplus") return Reflect.apply(originalSend, this, [message, ...args]);
            sent = () => args.at(-1)(null);
            return true;
        });
        response = h.request("/api/purchase/stop", { runId: run.id });
        await waitFor(async () => Boolean(sent));
        await writeFile(h.report + ".control", "release-queue");
        await h.until(run => run?.status === "payment-ready");
        sent!();
        assert.equal((await response).status, 200);
        assert.equal((await h.snapshot())!.status, "payment-ready");
        assert.equal((await h.counts()).counts.submit, 1);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
    } finally {
        sent?.();
        await response?.catch(() => {});
        t.mock.restoreAll();
        await h.dispose();
    }
});

test("停止 API：本輪全部目標售完後等待更新可停止，worker 不啟動刷新", async () => {
    const h = await apiHarness("cycle-all-sold-out");
    try {
        await launch(h);
        await login(h);
        const waiting = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-to-refresh"),
            ),
        );
        assert.equal((await h.request("/api/purchase/stop", { runId: waiting.id })).status, 200);
        const finished = await h.until(run => run?.status === "failed");
        assert.match(finished.message, /已依要求停止/);
        assert.equal(finished.browserOpen, true);
        assert.equal(finished.occupied, true);
        const report = await h.counts();
        assert.equal(report.counts.submit, 0);
        assert.equal(report.counts.other, 0);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: waiting.id })).status, 200);
        await h.until(run => !run?.occupied);
    } finally {
        await h.dispose();
    }
});
