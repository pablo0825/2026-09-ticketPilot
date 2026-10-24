import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityStore, parseActivity, toPurchaseConfig } from "../src/config/activityStore.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";

const legacySettings = {
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "平台相容測試",
    currency: "TWD",
    fallbackMode: "STRICT",
    excludeKeywords: ["身障"],
    targets: [
        {
            date: "2026-11-21",
            time: "19:30",
            area: "B區",
            unitPrice: 100,
            quantity: 2,
            adjacent: true,
            bundle: "套票1",
        },
        {
            date: "2026-11-22",
            time: "18:00",
            area: "C區",
            unitPrice: 200,
            quantity: 1,
            adjacent: false,
            bundle: "套票2",
        },
    ],
    queueEnabled: true,
    bundleEnabled: true,
    deliveryMethod: "自取",
    saleSchedule: { saleAt: "2027-01-01T10:00:00+08:00", advanceSeconds: 1 },
};
const current = { platform: "klook", ...legacySettings };
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "demo@example.com",
};

async function legacyFixture(work: (store: ActivityStore, path: string, id: string, raw: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "ticket-platform-settings-"));
    const id = randomUUID();
    const path = join(dir, `${id}.json`);
    const raw = JSON.stringify({
        schemaVersion: 1,
        id,
        updatedAt: "2026-10-01T00:00:00.000Z",
        settings: legacySettings,
    });
    try {
        await writeFile(path, raw);
        await work(new ActivityStore(dir), path, id, raw);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

test("舊活動僅讀取補平台；首次儲存備份原檔且保留 ID、順位與條件", async () => {
    await legacyFixture(async (store, path, id, raw) => {
        const loaded = await store.load(id);
        assert.equal(loaded.schemaVersion, 1);
        assert.equal(loaded.updatedAt, "2026-10-01T00:00:00.000Z");
        assert.equal(loaded.settings.platform, "klook");
        assert.equal(await readFile(path, "utf8"), raw);
        await assert.rejects(readFile(path + ".v1.bak"), { code: "ENOENT" });

        const saved = await store.save(loaded.settings, id);
        assert.equal(saved.schemaVersion, 3);
        assert.equal(saved.id, id);
        assert.deepEqual(saved.settings, loaded.settings);
        assert.equal(await readFile(path + ".v1.bak", "utf8"), raw);
        assert.deepEqual((await store.load(id)).settings, loaded.settings);
        assert.equal((await store.list()).activities.length, 1);
        assert.equal((await store.list()).invalidFiles, 0);
        assert.deepEqual(saved.settings.targets, [
            { date: "2026-11-21", time: "19:30", area: "B區", quantity: 2, adjacent: true, bundle: "套票1" },
            { date: "2026-11-22", time: "18:00", area: "C區", quantity: 1, adjacent: false, bundle: "套票2" },
        ]);
        assert.equal(saved.settings.deliveryMethod, "自取");
        assert.equal(saved.settings.queueEnabled, true);
        assert.deepEqual(saved.settings.saleSchedule, legacySettings.saleSchedule);
        assert(
            toPurchaseConfig(saved.settings).targets.every(target => target.expectation.eventName === "平台相容測試"),
        );
        await store.save({ ...saved.settings, eventName: "再次修改" }, id);
        assert.equal(await readFile(path + ".v1.bak", "utf8"), raw);
    });
});

test("備份衝突或無效保存不能覆寫舊檔；原樣備份容許安全重試保存", async () => {
    await legacyFixture(async (store, path, id, raw) => {
        await assert.rejects(store.save({ ...current, targets: [] }, id));
        await assert.rejects(readFile(path + ".v1.bak"), { code: "ENOENT" });
        await writeFile(path + ".v1.bak", "different");
        await assert.rejects(store.save(current, id), /備份與原檔不同/);
        assert.equal(await readFile(path, "utf8"), raw);
        await writeFile(path + ".v1.bak", raw);
        await store.save(current, id);
        assert.equal((await store.load(id)).schemaVersion, 3);
    });
});

test("僅 v1 讀檔能補平台；其他版本、缺平台與假冒平台嚴格拒絕", async () => {
    for (const input of [
        legacySettings,
        { ...current, platform: "ticketplus" },
        { ...current, platform: "unknown" },
        { ...current, eventUrl: "https://ticketplus.com.tw/" },
    ]) {
        assert.throws(() => parseActivity(input));
    }
    await legacyFixture(async (store, path, id, raw) => {
        const original = JSON.parse(raw);
        for (const patch of [
            { settings: current }, // v1 不接受偷偷加入的平台。
            { settings: { ...current, platform: "ticketplus" } },
            { schemaVersion: 3 }, // 新版缺平台。
            { schemaVersion: 2, settings: { platform: "klook", sessions: [], priorities: [] } },
        ]) {
            const invalid = JSON.stringify({ ...original, ...patch });
            await writeFile(path, invalid);
            await assert.rejects(store.load(id));
            assert.equal(await readFile(path, "utf8"), invalid);
        }
    });
});

test("錯誤平台在 worker 與占用之前拒絕", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-platform-start-"));
    const runs = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
    try {
        for (const input of [
            legacySettings,
            { ...current, platform: "ticketplus" },
            { ...current, eventUrl: "https://ticketplus.com.tw/" },
        ]) {
            assert.throws(() => runs.start(randomUUID(), input, contact));
            assert.equal(runs.busy(), false);
            assert.equal(runs.snapshot(), null);
        }
        assert.deepEqual(await readdir(join(dir, "runs")), []);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});
