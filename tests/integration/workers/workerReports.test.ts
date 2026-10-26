import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerReport } from "../../../src/workers/workerReports.js";
import { ticketPlusDefinition } from "../../../src/app/platforms/ticketplus/definition.js";
import { PurchaseRuns } from "../../../src/server/runs/purchaseRuns.js";
import { apiActivity } from "../../fixtures/ticketplus/apiHarness.js";

const parse = (value: unknown) => parseWorkerReport(value, ticketPlusDefinition);

test("worker 結果與生命週期回報必須完整；未知結果與多餘欄位不能存檔", () => {
    for (const value of [
        { type: "result", outcome: "failed" },
        { type: "result", outcome: "failed", message: 123 },
        { type: "result", outcome: "success", message: "錯誤結果" },
        { type: "result", outcome: "failed", message: "停止", occupied: false },
        { type: "browser", open: "false" },
        { type: "browser" },
        { type: "finished", extra: true },
        { type: "close-error", extra: true },
    ])
        assert.throws(() => parse(value));
    assert.throws(() =>
        parseWorkerReport(
            { type: "result", outcome: "registration-ready", message: "不支援" },
            { ...ticketPlusDefinition, acceptsResult: (_value): _value is "payment-ready" => false },
        ),
    );
});

test("合法回報保留安全欄位；舊事件、未知訊息與未知停止原因沿用相容規則", () => {
    for (const report of [
        { type: "result", outcome: "failed", message: "停止", stopReason: "user-stop" },
        { type: "browser", open: false },
        { type: "finished" },
        { type: "close-error" },
        { type: "event", event: { type: "ticketplus", stage: "submitting" } },
        { type: "event", event: { type: "log", message: "進度" } },
    ])
        assert.deepEqual(parse(report), report);
    for (const value of [
        null,
        { type: "unknown" },
        { type: "event", event: { type: "state", state: "OLD" } },
        { type: "event", event: { type: "log", message: 123 } },
    ])
        assert.equal(parse(value), undefined);
    assert.deepEqual(parse({ type: "result", outcome: "failed", message: "停止", stopReason: "crash" }), {
        type: "result",
        outcome: "failed",
        message: "停止",
    });
});

test("無效 IPC 結果停止程序、保留去重與占用，重啟仍能讀取紀錄", async () => {
    for (const report of [
        { type: "result", outcome: "failed" },
        { type: "result", outcome: "failed", message: 123 },
        { type: "result", outcome: "not-supported", message: "未知" },
        { type: "browser", open: "false" },
        { type: "finished", extra: true },
    ]) {
        const directory = await mkdtemp(join(tmpdir(), "worker-report-"));
        const worker = new URL("../../fixtures/reportBoundaryWorker.ts", import.meta.url);
        const runs = new PurchaseRuns(directory, worker);
        try {
            await writeFile(join(directory, "report.json"), JSON.stringify(report));
            const requestId = randomUUID();
            runs.start(requestId, apiActivity);
            const deadline = Date.now() + 7_000;
            while (runs.snapshot()?.status !== "interrupted" && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            assert.equal(runs.snapshot()?.status, "interrupted");
            assert.equal(runs.snapshot()?.occupied, true);
            assert.equal(typeof runs.snapshot()?.message, "string");
            await assert.rejects(readFile(join(directory, "worker-timeout.txt")), { code: "ENOENT" });
            runs.close();
            const restored = new PurchaseRuns(directory, worker);
            try {
                assert.equal(restored.snapshot()?.status, "interrupted");
                assert.equal(restored.hasRequest(requestId), true);
                assert.equal(restored.start(requestId, apiActivity).status, "interrupted");
                assert.throws(() => restored.start(randomUUID(), apiActivity), /占用/);
                assert.equal(await readFile(join(directory, "worker-starts.txt"), "utf8"), "started\n");
            } finally {
                restored.close();
            }
        } finally {
            runs.close();
            await rm(directory, { recursive: true, force: true });
        }
    }
});
