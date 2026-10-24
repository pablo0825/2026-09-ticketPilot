import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { acquirePurchaseLease, purchaseOccupied, releasePurchaseLease } from "../src/storage/purchaseLock.js";
import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";

const worker = new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url);
function historicalRecord(requestId: string, platform?: string, status = "unknown") {
    return {
        fingerprintVersion: 4,
        fingerprint: "a".repeat(64),
        snapshot: {
            ...(platform === undefined ? {} : { platform }),
            id: `1-${requestId}`,
            requestId,
            activityName: "舊活動",
            status,
            browserOpen: false,
            occupied: false,
            message: "提交結果不明",
            historyTruncated: false,
            events: [{ sequence: 1, at: "2026-10-01T00:00:00.000Z", event: { type: "log", message: "舊紀錄" } }],
        },
    };
}

for (const platform of [undefined, "klook"]) {
    for (const status of ["running", "unknown", "payment-ready"]) {
        test(`舊 Klook ${platform ?? "缺平台"}/${status}：不顯示、不改寫，同 ID 在占用前拒絕`, async () => {
            const dir = await mkdtemp(join(tmpdir(), "ticket-retired-run-"));
            let runs: PurchaseRuns | undefined;
            try {
                const id = randomUUID();
                const record = historicalRecord(id, platform, status);
                const raw = JSON.stringify(record);
                await mkdir(join(dir, "runs"));
                const path = join(dir, "runs", `${id}.json`);
                await writeFile(path, raw);
                runs = new PurchaseRuns(dir, worker);
                assert.equal(runs.snapshot(), null);
                assert.equal(runs.hasRequest(id), true);
                assert.throws(() => runs!.start(id, apiActivity), /Klook|已停用|不支援/);
                assert.equal(runs.busy(), false);
                assert.equal(purchaseOccupied(dir), false);
                assert.equal(await readFile(path, "utf8"), raw);
                assert.deepEqual(await readdir(join(dir, "runs")), [`${id}.json`]);
                await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
            } finally {
                runs?.close();
                await rm(dir, { recursive: true, force: true });
            }
        });
    }
}

test("混合紀錄先排除 Klook，再選 TicketPlus 目前紀錄；舊 running 不被寫回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-mixed-run-"));
    try {
        await mkdir(join(dir, "runs"));
        const oldId = randomUUID();
        const currentId = randomUUID();
        const old = historicalRecord(oldId, "klook", "running");
        old.snapshot.id = "9999999999999-old";
        const raw = JSON.stringify(old);
        const path = join(dir, "runs", oldId + ".json");
        await writeFile(path, raw);
        const current = historicalRecord(currentId, "ticketplus", "running");
        current.snapshot.id = "123-current";
        await writeFile(join(dir, "runs", currentId + ".json"), JSON.stringify(current));
        const runs = new PurchaseRuns(dir, worker);
        assert.equal(runs.snapshot()?.id, current.snapshot.id);
        assert.equal(runs.snapshot()?.status, "interrupted");
        assert.equal(runs.snapshot()?.platform, "ticketplus");
        assert.equal(await readFile(path, "utf8"), raw);
        runs.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("未知平台、損壞結構及平台矛盾不能當 Klook 略過，服務停止啟動", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-invalid-run-"));
    try {
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const path = join(dir, "runs", id + ".json");
        const record = historicalRecord(id);
        const invalid = [
            "{broken",
            JSON.stringify({}),
            JSON.stringify({ ...record, snapshot: { ...record.snapshot, id: undefined } }),
            ...["unknown", null, 123].map(platform =>
                JSON.stringify({ ...record, snapshot: { ...record.snapshot, platform } }),
            ),
            JSON.stringify({
                ...record,
                snapshot: {
                    ...record.snapshot,
                    platform: "klook",
                    events: [
                        {
                            sequence: 1,
                            at: "2026-10-01T00:00:00.000Z",
                            event: { type: "ticketplus", stage: "waiting-for-login" },
                        },
                    ],
                },
            }),
        ];
        for (const raw of invalid) {
            await writeFile(path, raw);
            assert.throws(() => new PurchaseRuns(dir, worker), /執行紀錄無法讀取/);
            assert.equal(await readFile(path, "utf8"), raw);
            assert.equal(purchaseOccupied(dir), false);
        }
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("隱藏 Klook 紀錄仍保留外部占用，不標示為 TicketPlus、不啟動 worker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-external-run-"));
    let runs: PurchaseRuns | undefined;
    try {
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const raw = JSON.stringify(historicalRecord(id, "klook"));
        const path = join(dir, "runs", id + ".json");
        await writeFile(path, raw);
        const lease = acquirePurchaseLease(dir);
        try {
            runs = new PurchaseRuns(dir, worker);
            assert.equal(runs.snapshot()?.platform, null);
            assert.equal(runs.snapshot()?.occupied, true);
            assert.throws(() => runs!.start(randomUUID(), apiActivity), /占用/);
            assert.throws(() => runs!.start(id, apiActivity), /Klook|已停用|不支援/);
            assert.equal(purchaseOccupied(dir), true);
            assert.equal(await readFile(path, "utf8"), raw);
            await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
        } finally {
            releasePurchaseLease(lease);
        }
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});
