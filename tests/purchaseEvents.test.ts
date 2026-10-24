import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { eventLogs, purchaseStatus } from "../src/local/react/shared/runs/runPresentation.js";
import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";

const legacyEvents = [
    { type: "log", message: "舊文字紀錄" },
    { type: "state", state: "WAITING_FOR_SALE" },
    { type: "target", index: 1, total: 2, area: "A區", quantity: 1, date: "2026-11-02", time: "19:30" },
    { type: "recovery", queue: 1, reservation: 0 },
];

test("舊 TicketPlus 的文字、狀態、順位與恢復事件仍可讀取顯示，不改寫歷史檔", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-historical-events-"));
    let runs: PurchaseRuns | undefined;
    try {
        await mkdir(join(directory, "runs"));
        const requestId = randomUUID();
        const events = legacyEvents.map((event, index) => ({
            sequence: index + 1,
            at: "2026-10-01T00:00:00.000Z",
            event,
        }));
        const raw = JSON.stringify({
            fingerprintVersion: 4,
            fingerprint: "a".repeat(64),
            snapshot: {
                platform: "ticketplus",
                id: "123-historical-events",
                requestId,
                activityName: "舊活動",
                status: "failed",
                browserOpen: false,
                occupied: false,
                message: "已停止",
                historyTruncated: false,
                events,
            },
        });
        const file = join(directory, "runs", requestId + ".json");
        await writeFile(file, raw);
        runs = new PurchaseRuns(directory);
        const snapshot = runs.snapshot();
        assert(snapshot);
        assert.deepEqual(snapshot.events, events);
        const logs = eventLogs(snapshot.events, false);
        for (const text of ["舊文字紀錄", "A區", "排隊 1/1", "預留 0/1"]) {
            assert(logs.includes(text), text);
        }
        assert.equal(purchaseStatus({ ...snapshot, status: "running" }, false, Date.now()).title, "等待開賣");
        assert.equal(await readFile(file, "utf8"), raw);
    } finally {
        runs?.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("新 worker 接受文字與 TicketPlus 事件，忽略舊 Klook 事件及無效事件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-live-events-"));
    const runs = new PurchaseRuns(directory, new URL("./fixtures/ticketplus/eventBoundaryWorker.ts", import.meta.url));
    try {
        runs.start(randomUUID(), apiActivity);
        const deadline = Date.now() + 5_000;
        while (runs.busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(runs.busy(), false);
        const snapshot = runs.snapshot();
        assert(snapshot);
        assert.deepEqual(
            snapshot.events.map(item => item.event),
            [
                { type: "log", message: "新的文字紀錄" },
                { type: "ticketplus", stage: "selecting-tickets" },
                { type: "log", message: "事件傳送完成" },
            ],
        );
        assert.deepEqual(
            snapshot.events.map(item => item.sequence),
            [1, 2, 3],
        );
        const restored = new PurchaseRuns(directory);
        try {
            assert.deepEqual(restored.snapshot()?.events, snapshot.events);
        } finally {
            restored.close();
        }
    } finally {
        runs.close();
        await rm(directory, { recursive: true, force: true });
    }
});
