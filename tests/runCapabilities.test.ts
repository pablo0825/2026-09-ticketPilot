import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { parseRunRecord } from "../src/server/runs/runRecord.js";
import { runCapabilities } from "../src/app/platforms/runCapabilities.js";

test("能力由登記處產生；歷史磁碟不能恢復操作資格", () => {
    const id = randomUUID();
    const record = parseRunRecord(
        {
            fingerprintVersion: 5,
            fingerprint: "a".repeat(64),
            snapshot: {
                platform: "ticketplus",
                id: "fixture",
                requestId: id,
                activityName: "fixture",
                status: "failed",
                browserOpen: false,
                occupied: false,
                message: "fixture",
                events: [],
                historyTruncated: false,
                capabilities: { stop: true, participants: true },
                canStop: true,
                participantConfirmation: { confirmationId: randomUUID() },
            },
        },
        id,
    );
    assert.notEqual(record, "archived-klook");
    if (record === "archived-klook") return;
    assert.equal(Object.hasOwn(record.snapshot, "capabilities"), false);
    assert.equal(Object.hasOwn(record.snapshot, "canStop"), false);
    assert.equal(Object.hasOwn(record.snapshot, "participantConfirmation"), false);
    assert.deepEqual(runCapabilities("ticketplus"), { stop: true, participants: true });
    assert.deepEqual(runCapabilities(null), { stop: false, participants: false });
});
