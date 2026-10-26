import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseActivity } from "../../../src/config/activitySettings.js";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { PurchaseRuns } from "../../../src/server/runs/purchaseRuns.js";

const legacySettings = {
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "平台相容測試",
    currency: "TWD",
    fallbackMode: "STRICT",
    excludeKeywords: ["身障"],
    targets: [{ date: "2026-11-21", time: "19:30", area: "B區", unitPrice: 100, quantity: 2, adjacent: true }],
};
const current = { platform: "klook", ...legacySettings };
const ticketPlus = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "TicketPlus 測試",
    targets: [{ date: "2026-11-21", time: "19:30", ticketType: "全票", quantity: 1 }],
};

async function fixture(work: (store: ActivityStore, dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "ticket-platform-settings-"));
    try {
        await work(new ActivityStore(dir), dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

function record(settings: unknown, schemaVersion: number) {
    return { schemaVersion, id: randomUUID(), updatedAt: "2026-10-01T00:00:00.000Z", settings };
}

test("混合活動只列 TicketPlus；封存 Klook 不可載入、修改或刪除，也不改寫或備份原檔", async () => {
    await fixture(async (store, dir) => {
        const active = await store.save(ticketPlus);
        const savedFiles = [];
        for (const archived of [record(legacySettings, 1), record(current, 3)]) {
            const path = join(dir, `${archived.id}.json`);
            const raw = JSON.stringify(archived, null, 2) + "\n";
            await writeFile(path, raw);
            savedFiles.push({ path, raw });
            await assert.rejects(store.load(archived.id), /已不支援 Klook/);
            await assert.rejects(store.remove(archived.id), /已不支援 Klook/);
            await assert.rejects(store.save(ticketPlus, archived.id), /已不支援 Klook/);
            await assert.rejects(store.save(current, archived.id), /已不支援 Klook/);
        }
        const result = await store.list();
        assert.deepEqual(result.activities, [active]);
        assert.equal(result.invalidFiles, 0);
        for (const { path, raw } of savedFiles) assert.equal(await readFile(path, "utf8"), raw);
        assert.equal((await readdir(dir)).length, 3);
        await assert.rejects(store.save(current), /已不支援 Klook/);
        assert.equal((await readdir(dir)).length, 3);
    });
});

test("無平台但缺少必要結構、矛盾平台與未知欄位仍計為無效，不靜默略過", async () => {
    await fixture(async (store, dir) => {
        const invalidRecords = [
            record({}, 1),
            record({ ...legacySettings, targets: [] }, 1),
            record({ ...legacySettings, targets: ticketPlus.targets }, 1),
            record({ ...legacySettings, flowType: "lottery" }, 1),
            record(current, 1),
            record(ticketPlus, 1),
            record(legacySettings, 3),
            record({ ...current, platform: "unknown" }, 3),
            record({ ...current, targets: ticketPlus.targets }, 3),
            record({ ...current, eventUrl: ticketPlus.eventUrl }, 3),
            record({ ...current, unknown: true }, 3),
            record(current, 2),
        ];
        for (const invalid of invalidRecords) {
            const path = join(dir, `${invalid.id}.json`);
            const raw = JSON.stringify(invalid);
            await writeFile(path, raw);
            await assert.rejects(store.load(invalid.id));
            assert.equal(await readFile(path, "utf8"), raw);
        }
        assert.deepEqual(await store.list(), { activities: [], invalidFiles: invalidRecords.length });
    });
});

test("Klook 與錯誤平台在 worker 與占用之前拒絕", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-platform-start-"));
    const runs = new PurchaseRuns(dir, new URL("../../fixtures/countedPurchaseWorker.ts", import.meta.url));
    try {
        for (const input of [
            legacySettings,
            current,
            { ...current, platform: "ticketplus" },
            { ...current, platform: "unknown" },
        ]) {
            assert.throws(() => parseActivity(input));
            assert.throws(() => runs.start(randomUUID(), input));
            assert.equal(runs.busy(), false);
            assert.equal(runs.snapshot(), null);
        }
        assert.deepEqual(await readdir(join(dir, "runs")), []);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
        await assert.rejects(readFile(join(dir, "purchase.lock")), { code: "ENOENT" });
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});
