import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { PurchaseRuns } from "../src/server/runs/purchaseRuns.js";
import { purchaseOccupied } from "../src/storage/purchaseLock.js";

async function start(h: Awaited<ReturnType<typeof apiHarness>>) {
    const created = await (await h.request("/api/activities", apiActivity)).json();
    const requestId = randomUUID();
    assert.equal(
        (await h.request("/api/purchase", { requestId, activityId: created.id, expectedActivity: apiActivity })).status,
        200,
    );
    const run = await h.until(run =>
        Boolean(run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login")),
    );
    return { requestId, run };
}

test("真 API：登入由網頁觀測確認，舊確認不可放行；導航及提交各一次", { timeout: 25_000 }, async () => {
    const h = await apiHarness();
    try {
        const { requestId, run } = await start(h);
        const stale = { runId: run.id, confirmationId: randomUUID() };
        assert.equal(run.loginConfirmation, undefined);
        for (let i = 0; i < 2; i++) assert.equal((await h.request("/api/purchase/confirm-login", stale)).status, 400);
        assert.deepEqual((await h.counts()).requests, ["/"]);
        assert.equal((await h.counts()).counts.session, 0);
        // 外部測試操作只改網頁會員區，正式 runner 自行讀取並繼續。
        await h.login();
        const result = await h.until(run => run?.status === "payment-ready");
        assert.equal(result.loginConfirmation, undefined);
        assert.equal(result.occupied, true);
        assert.deepEqual((await h.counts()).requests, [
            "/",
            "/activity/event-fixture",
            "/order/event-fixture/session-B",
            "/confirm/event-fixture/session-B",
            "/checkout/event-fixture/session-B",
        ]);
        assert.deepEqual((await h.counts()).counts, {
            session: 1,
            plus: 2,
            submit: 1,
            dismiss: 0,
            information: 1,
            other: 0,
            terms: 0,
        });
        const raw = await readFile(join(h.runtime, "runs", requestId + ".json"), "utf8");
        assert.doesNotMatch(raw, /0987|PRIVATE_INFORMATION_MARKER/);
        assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
        assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
        await h.until(run => !run?.occupied);
        assert(!purchaseOccupied(h.runtime));
        const restored = new PurchaseRuns(h.runtime);
        assert.equal(restored.snapshot()!.status, "payment-ready");
        assert.equal(restored.snapshot()!.loginConfirmation, undefined);
        await assert.rejects(restored.confirmLogin(run.id, stale.confirmationId));
    } finally {
        await h.dispose();
    }
});

test("登入等待可取消，之後的網頁登入不能啟動選票", async () => {
    const h = await apiHarness();
    try {
        const { run } = await start(h);
        assert.equal((await h.request("/api/purchase/stop", { runId: run.id })).status, 200);
        await h.until(run => run?.status === "failed");
        await h.login();
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.deepEqual((await h.counts()).requests, ["/"]);
        assert.equal((await h.counts()).counts.submit, 0);
    } finally {
        await h.dispose();
    }
});

test("真 API：售完與提交後關頁保留原結果且不重送", { timeout: 30_000 }, async () => {
    for (const mode of ["failure", "close-after-submit"]) {
        const h = await apiHarness(mode);
        try {
            await start(h);
            await h.login();
            const result = await h.until(run => run?.status === (mode === "failure" ? "failed" : "unknown"));
            assert.equal(result.loginConfirmation, undefined);
            assert.equal((await h.counts()).counts.submit, 1);
            assert.equal((await h.counts()).counts.information, 0);
            assert.equal((await h.counts()).counts.dismiss, mode === "failure" ? 1 : 0);
        } finally {
            await h.dispose();
        }
    }
});
