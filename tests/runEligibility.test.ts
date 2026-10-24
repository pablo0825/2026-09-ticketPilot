import assert from "node:assert/strict";
import { test } from "node:test";
import { sameRun, runningWithCapability } from "../src/gui/shared/runs/runEligibility.js";
import type { PurchaseSnapshot } from "../src/shared/runSnapshot.js";
const run: PurchaseSnapshot = {
    platform: "ticketplus",
    id: "run",
    requestId: "request",
    activityName: "fixture",
    status: "running",
    browserOpen: true,
    occupied: true,
    message: "",
    events: [],
    historyTruncated: false,
};

test("操作能力缺少或不支援時不授權，已結束與不同身份不能當成目前執行", () => {
    assert.equal(runningWithCapability(run, "stop"), false);
    const enabled = { ...run, capabilities: { stop: true, participants: false } };
    assert.equal(runningWithCapability(enabled, "stop"), true);
    assert.equal(runningWithCapability(enabled, "participants"), false);
    assert.equal(runningWithCapability({ ...enabled, status: "failed" }, "stop"), false);
    assert.equal(sameRun({ ...run, platform: null }, run), false);
    assert.equal(sameRun({ ...run, id: "other" }, run), false);
    assert.equal(sameRun({ ...run }, run), true);
});
