import { klookSettings } from "./fixtures/klookSettings.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore, parseActivity, toPurchaseConfig } from "../src/config/activityStore.js";
import { normalizePurchaseConfig } from "../src/core/purchaseValidation.js";

const settings = {
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/102001116-fixture/",
    eventName: "排隊設定測試",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-21", time: "19:00", area: "B區", quantity: 1, adjacent: false }],
};

test("舊設定與 false 正規化相同；true 通過儲存、購票轉換、核心驗證", async () => {
    const original = parseActivity(settings);
    assert.equal(JSON.stringify(parseActivity({ ...settings, queueEnabled: false })), JSON.stringify(original));
    const config = normalizePurchaseConfig(toPurchaseConfig(parseActivity({ ...settings, queueEnabled: true })));
    assert.equal(config.queueEnabled, true);
    assert.equal(normalizePurchaseConfig({ ...config, queueEnabled: false }).queueEnabled, undefined);
    for (const value of ["true", 1, null, {}]) {
        assert.throws(() => parseActivity({ ...settings, queueEnabled: value }));
        assert.throws(() => normalizePurchaseConfig({ ...config, queueEnabled: value as boolean }));
    }
    const dir = await mkdtemp(join(tmpdir(), "ticket-queue-settings-"));
    try {
        const store = new ActivityStore(dir);
        const record = await store.save({ ...settings, queueEnabled: true });
        assert.equal(klookSettings((await store.load(record.id)).settings).queueEnabled, true);
        await store.save({ ...settings, queueEnabled: false }, record.id);
        assert.deepEqual(klookSettings((await store.load(record.id)).settings), original);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
