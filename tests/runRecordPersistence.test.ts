import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PurchaseRuns } from "../src/server/runs/purchaseRuns.js";
import { purchaseOccupied } from "../src/storage/purchaseLock.js";
import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { historicalRecord } from "./fixtures/runRecords.js";

const worker = new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url);

test("執行紀錄資料夾只開放本人存取", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-dir-"));
    let runs: PurchaseRuns | undefined;
    try {
        runs = new PurchaseRuns(dir, worker);
        assert.equal((await stat(join(dir, "runs"))).mode & 0o777, 0o700);
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("上次執行中的紀錄改為已中斷並寫回檔案，暫存檔不被讀取或刪除", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-interrupted-"));
    let runs: PurchaseRuns | undefined;
    try {
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const record = historicalRecord(id, "ticketplus", "running");
        const path = join(dir, "runs", `${id}.json`);
        await writeFile(path, JSON.stringify(record));
        // 寫入中斷留下的暫存檔不符合紀錄檔名，啟動時不能把它當成紀錄。
        const leftover = `${id}.json.${randomUUID()}.tmp`;
        await writeFile(join(dir, "runs", leftover), "{broken");

        runs = new PurchaseRuns(dir, worker);
        assert.equal(runs.snapshot()?.status, "interrupted");

        const saved = JSON.parse(await readFile(path, "utf8"));
        assert.equal(saved.snapshot.status, "interrupted");
        assert.equal(saved.snapshot.message, "上次服務中斷，請檢查瀏覽器與訂單；不會自動續跑。");
        assert.deepEqual(saved.snapshot.events, record.snapshot.events);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual((await readdir(join(dir, "runs"))).sort(), [`${id}.json`, leftover].sort());
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("無法確認的請求 ID 視為已接受；無效 ID 在占用前拒絕，不建立紀錄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-invalid-id-"));
    let runs: PurchaseRuns | undefined;
    try {
        runs = new PurchaseRuns(dir, worker);
        // 無法確認時不能回報未接受，否則畫面會換新 ID 重送。
        assert.equal(runs.hasRequest("not-a-uuid"), true);
        assert.equal(runs.hasRequest(randomUUID()), false);

        assert.throws(() => runs!.start("not-a-uuid", apiActivity), {
            message: "執行紀錄無法讀取，請先人工檢查。",
        });
        assert.equal(runs.busy(), false);
        assert.equal(purchaseOccupied(dir), false);
        assert.deepEqual(await readdir(join(dir, "runs")), []);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});
