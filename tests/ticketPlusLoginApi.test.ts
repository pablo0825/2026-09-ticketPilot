import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { readFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { apiHarness, apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";

async function start(h: Awaited<ReturnType<typeof apiHarness>>) {
    const created = await (await h.request("/api/activities", apiActivity)).json();
    const requestId = randomUUID();
    const response = await h.request("/api/purchase", {
        requestId,
        activityId: created.id,
        expectedActivity: apiActivity,
    });
    assert.equal(response.status, 200);
    const run = await h.until(run => Boolean(run?.loginConfirmation));
    return { requestId, run, confirmation: { runId: run.id, confirmationId: run.loginConfirmation!.confirmationId } };
}

test("真 API 登入交接：就緒後立即並行確認只有一次，資料頁停止、落盤與關窗收尾", { timeout: 25_000 }, async () => {
    const h = await apiHarness();
    try {
        const { requestId, run, confirmation } = await start(h);
        // GET 公告就緒後立即確認，不用 sleep 等待 worker。
        const responses = await Promise.all([
            h.request("/api/purchase/confirm-login", confirmation),
            h.request("/api/purchase/confirm-login", confirmation),
        ]);
        assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
        const accepted = await responses.find(response => response.status === 200)!.json();
        assert.equal(accepted.status, "sent");
        assert.match(accepted.message, /已送出.*查看後續/);
        assert.equal(accepted.run.loginConfirmation, undefined);
        const rejected = await responses.find(response => response.status === 400)!.json();
        assert.equal(rejected.notAccepted, undefined);
        assert.equal((await h.snapshot())!.loginConfirmation, undefined);
        const result = await h.until(run => run?.status === "information-ready");
        assert.equal(result.canCloseBrowser, true);
        assert.equal(result.occupied, true);
        assert(purchaseOccupied(h.runtime));
        assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 400);
        const report = await h.counts();
        assert.deepEqual(report.counts, {
            session: 1,
            plus: 2,
            submit: 1,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        assert.deepEqual(report.requests, [
            "/activity/event-fixture",
            "/order/event-fixture/session-B",
            "/confirm/event-fixture/session-B",
        ]);
        assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
        const raw = await readFile(join(h.runtime, "runs", requestId + ".json"), "utf8");
        assert.doesNotMatch(raw, /PRIVATE_INFORMATION_MARKER|"information":/);
        assert.equal(JSON.parse(raw).snapshot.status, "information-ready");
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
        await h.until(run => !run?.occupied);
        const restored = new PurchaseRuns(h.runtime);
        assert.equal(restored.snapshot()!.status, "information-ready");
        assert.equal(restored.snapshot()!.loginConfirmation, undefined);
        await assert.rejects(restored.confirmLogin(run.id, confirmation.confirmationId), /失效/);
        assert(!purchaseOccupied(h.runtime));
    } finally {
        await h.dispose();
    }
});

test("登入確認拒絕錯誤／舊ID、額外欄位及跨來源，取消後資格失效且零點擊", async () => {
    const h = await apiHarness();
    try {
        assert.equal(
            (await h.request("/api/purchase/confirm-login", { runId: "old", confirmationId: randomUUID() })).status,
            400,
        );
        const { run, confirmation } = await start(h);
        for (const body of [
            { ...confirmation, runId: "old-run" },
            { ...confirmation, confirmationId: randomUUID() },
            { ...confirmation, extra: true },
        ]) {
            const response = await h.request("/api/purchase/confirm-login", body);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).notAccepted, undefined);
        }
        for (const headers of [
            { "Content-Type": "application/json" },
            { ...h.headers, Origin: "https://other.example" },
        ]) {
            const response = await fetch(h.url + "/api/purchase/confirm-login", {
                method: "POST",
                headers,
                body: JSON.stringify(confirmation),
            });
            assert.equal(response.status, 403);
        }
        assert.deepEqual((await h.snapshot())!.loginConfirmation, run.loginConfirmation);
        assert.equal((await h.counts()).counts.session, 0);
        await h.closePage();
        await h.until(run => run?.status === "failed");
        assert.equal((await h.snapshot())!.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 400);
        assert.equal((await h.counts()).counts.session, 0);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
    } finally {
        await h.dispose();
    }
});

test("真 API：已售完及提交後關頁保留失敗／unknown，不重送也不恢復登入確認", { timeout: 30_000 }, async () => {
    for (const mode of ["failure", "close-after-submit"]) {
        const h = await apiHarness(mode);
        try {
            const { run, confirmation } = await start(h);
            assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 200);
            const result = await h.until(run => run?.status === (mode === "failure" ? "failed" : "unknown"));
            if (mode === "failure") assert.match(result.message, /已售完.*已確認關閉/);
            else assert.match(result.message, /結果未確認.*不會重送/);
            assert.equal(result.loginConfirmation, undefined);
            assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 400);
            const counts = (await h.counts()).counts;
            assert.equal(counts.submit, 1);
            assert.equal(counts.dismiss, mode === "failure" ? 1 : 0);
            assert.equal(counts.information, 0);
            assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
        } finally {
            await h.dispose();
        }
    }
});

test("登入確認前紀錄寫入失敗：零傳送／零選票、資格消耗且占用保留", async () => {
    const h = await apiHarness();
    try {
        const { requestId, confirmation } = await start(h);
        const file = join(h.runtime, "runs", requestId + ".json");
        await rename(file, file + ".backup");
        await mkdir(file); // 不依使用者權限，確實讓原子 rename 失敗。
        const response = await h.request("/api/purchase/confirm-login", confirmation);
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /寫入失敗.*未傳送/);
        await h.until(run => run?.status === "interrupted");
        assert.equal((await h.snapshot())!.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 400);
        assert.equal((await h.counts()).counts.session, 0);
        assert.equal((await h.counts()).counts.submit, 0);
        assert(purchaseOccupied(h.runtime));
    } finally {
        await h.dispose();
    }
});

test("真 API 的 IPC 失敗：重複 ready 不恢復資格，第二次確認不再傳送", async t => {
    const h = await apiHarness();
    const originalEmit = ChildProcess.prototype.emit;
    let workerChild: ChildProcess | undefined;
    let confirmations = 0;
    try {
        t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: any[]) {
            if (event === "message" && args[0]?.event?.stage === "login-ready") workerChild = this;
            return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        const { confirmation } = await start(h);
        assert(workerChild);
        const originalSend = workerChild.send;
        // 只注入父端傳送故障，資格的消耗、事件接收與 API 回覆仍走正式實作。
        t.mock.method(workerChild, "send", function (this: ChildProcess, message: any, ...args: any[]) {
            if (message?.type !== "confirm-ticketplus-login") {
                return Reflect.apply(originalSend, this, [message, ...args]);
            }
            confirmations++;
            args.at(-1)(new Error("PRIVATE_TRANSPORT_ERROR"));
            this.emit("message", {
                type: "event",
                event: { type: "ticketplus", stage: "login-ready", confirmationId: confirmation.confirmationId },
            });
            return false;
        });
        const response = await h.request("/api/purchase/confirm-login", confirmation);
        assert.equal(response.status, 400);
        const rejected = await response.json();
        assert.match(rejected.error, /未確認.*不會自動重送/);
        assert.doesNotMatch(rejected.error, /PRIVATE/);
        assert.equal(rejected.notAccepted, undefined);
        const snapshot = (await h.snapshot())!;
        assert.equal(snapshot.status, "running");
        assert.equal(snapshot.events.at(-1)!.event.type, "ticketplus");
        assert.equal(snapshot.loginConfirmation, undefined);
        assert.equal((await h.request("/api/purchase/confirm-login", confirmation)).status, 400);
        assert.equal(confirmations, 1);
        assert.equal((await h.counts()).counts.session, 0);
    } finally {
        t.mock.restoreAll();
        await h.dispose();
    }
});
