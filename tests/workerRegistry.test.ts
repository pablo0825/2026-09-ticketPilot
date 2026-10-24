import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createWorkerEntry, createWorkerRegistry, isStopMessage } from "../src/local/workerProtocol.js";
import { createParticipantGate } from "../src/local/participantConfirmation.js";

test("worker 依平台分派，保留 lease、signal 與同步提交回呼", async () => {
    const schema = z.object({ platform: z.literal("fixture"), count: z.number() });
    const lease = { path: "fixture-only", token: "fixture-token" };
    const signal = new AbortController().signal;
    const timeline: string[] = [];
    const lookup = createWorkerRegistry([
        createWorkerEntry(
            "fixture",
            value => schema.parse(value),
            async (input, env) => {
                assert.equal(input.activity.count, 2);
                assert.equal(input.lease, lease);
                assert.equal(env.signal, signal);
                env.onSubmitAttempt();
                timeline.push("attempt");
                return { outcome: "unknown", message: "fixture" };
            },
        ),
    ]);
    const entry = lookup("fixture");
    const result = await entry.run(
        { activity: { platform: "fixture", count: 2 }, lease },
        {
            signal,
            onBrowser: () => {},
            sendEvent: () => {},
            onSubmitAttempt: () => {
                timeline.push("marked");
            },
        },
    );
    assert.equal(result.outcome, "unknown");
    assert.deepEqual(timeline, ["marked", "attempt"]);
    assert.throws(() => lookup("ticketplus"));
});

test("平台控制訊息仍嚴格拒絕額外欄位、未支援及過早確認", async () => {
    assert.equal(isStopMessage({ type: "stop-fixture" }, "stop-fixture"), true);
    assert.equal(isStopMessage({ type: "stop-fixture", extra: true }, "stop-fixture"), false);
    assert.equal(isStopMessage({ type: "stop-fixture" }, undefined), false);
    const gate = createParticipantGate("confirm-fixture");
    assert.equal(gate.receive({ type: "confirm-fixture", confirmationId: "id" }), false);
    const waiting = gate.wait("id");
    assert.equal(gate.receive({ type: "confirm-fixture", confirmationId: "id", extra: true }), false);
    assert.equal(gate.receive({ type: "confirm-ticketplus-participants", confirmationId: "id" }), false);
    assert.equal(gate.receive({ type: "confirm-fixture", confirmationId: "id" }), true);
    await waiting;
    assert.equal(gate.receive({ type: "confirm-fixture", confirmationId: "id" }), false);
});
