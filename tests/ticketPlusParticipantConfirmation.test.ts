import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createParticipantGate } from "../src/local/participantConfirmation.js";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";

test("參加者確認閘門：只接受等待中的同一 ID 一次，提早、錯 ID、重複與多餘欄位都忽略", async () => {
    const gate = createParticipantGate();
    // 尚未等待時的確認不保留
    assert.equal(gate.receive({ type: "confirm-ticketplus-participants", confirmationId: "early" }), false);
    const waiting = gate.wait("id-1");
    let resolved = false;
    void waiting.then(() => {
        resolved = true;
    });
    for (const message of [
        { type: "confirm-ticketplus-participants", confirmationId: "wrong" },
        { type: "confirm-ticketplus-participants", confirmationId: "id-1", extra: true },
        { type: "other", confirmationId: "id-1" },
        "confirm",
    ]) {
        assert.equal(gate.receive(message), false);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(resolved, false);
    assert.equal(gate.receive({ type: "confirm-ticketplus-participants", confirmationId: "id-1" }), true);
    await waiting;
    assert.equal(gate.receive({ type: "confirm-ticketplus-participants", confirmationId: "id-1" }), false);
});

test("參加者確認 API：等待中提供確認 ID，錯 ID 拒絕，正確確認轉送一次後停在確認登記前", async () => {
    const h = await apiHarness("lottery");
    try {
        const activity = { ...apiActivity, flowType: "lottery" };
        const created = await (await h.request("/api/activities", activity)).json();
        const start = await h.request("/api/purchase", {
            requestId: randomUUID(),
            activityId: created.id,
            expectedActivity: activity,
        });
        assert.equal(start.status, 200, await start.clone().text());
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        const waiting = await h.until(run => Boolean(run?.participantConfirmation));
        const confirmationId = waiting.participantConfirmation!.confirmationId;
        assert.equal((await h.counts()).counts.terms, 0);

        // 錯 ID 不轉送；缺 token 不接受
        const wrong = await h.request("/api/purchase/confirm-participants", {
            runId: waiting.id,
            confirmationId: randomUUID(),
        });
        assert.equal(wrong.status, 400);
        const noToken = await fetch(h.url + "/api/purchase/confirm-participants", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: waiting.id, confirmationId }),
        });
        assert.notEqual(noToken.status, 200);
        assert.equal((await h.counts()).counts.terms, 0);

        // 正確確認轉送一次；之後不再提供確認 ID，重送拒絕
        const ok = await h.request("/api/purchase/confirm-participants", { runId: waiting.id, confirmationId });
        assert.equal(ok.status, 200);
        const again = await h.request("/api/purchase/confirm-participants", { runId: waiting.id, confirmationId });
        assert.equal(again.status, 400);
        const done = await h.until(run => run?.status === "registration-ready");
        assert.equal(done.participantConfirmation, undefined);
        const report = await h.counts();
        assert.equal(report.counts.terms, 1);
        assert.equal(report.counts.information, 1);
        assert.equal(report.counts.other, 0);
        assert.equal((await h.request("/api/purchase/close-browser", { runId: done.id })).status, 200);
        await h.until(run => !run?.occupied);
    } finally {
        await h.dispose();
    }
});
