import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ActivityStore, parseActivity, toPurchaseConfig } from "../src/config/activityStore.js";
import { normalizePurchaseConfig } from "../src/core/purchaseValidation.js";
import { startLocalServer } from "../src/local/server.js";

const settings = {
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
        assert.equal((await store.load(record.id)).settings.queueEnabled, true);
        await store.save({ ...settings, queueEnabled: false }, record.id);
        assert.deepEqual((await store.load(record.id)).settings, original);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("GUI 每活動保存勾選、摘要顯示、重開與新增不沿用其他活動", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-queue-gui-"));
    const store = new ActivityStore(join(dir, "events"));
    const original = await store.save(settings);
    await store.save({ ...settings, eventName: "另一場活動" });
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(service.url);
        await page.locator("#activities tr").filter({ hasText: settings.eventName }).getByText("使用活動").click();
        await page.locator("#step1").waitFor({ state: "visible" });
        assert.equal(await page.locator("#queueEnabled").isChecked(), false);
        await page.locator("#queueEnabled").check();
        assert.equal(await page.evaluate("activityNeedsSave()"), true);
        await page.locator("#saveActivity").click();
        await page.waitForFunction(() => !(window as any).activityNeedsSave());
        assert.equal((await store.load(original.id)).settings.queueEnabled, true);
        await page.evaluate("summary()");
        assert.match((await page.locator("#summary").textContent()) ?? "", /排隊流程.*已啟用/);
        await page.reload();
        await page.locator("#activities tr").filter({ hasText: settings.eventName }).getByText("使用活動").click();
        await page.locator("#step1").waitFor({ state: "visible" });
        assert.equal(await page.locator("#queueEnabled").isChecked(), true);
        assert.equal(await page.evaluate("activityNeedsSave()"), false);
        await page.locator("#homeButton").click();
        await page.locator("#activities tr").filter({ hasText: "另一場活動" }).getByText("使用活動").click();
        await page.locator("#step1").waitFor({ state: "visible" });
        assert.equal(await page.locator("#queueEnabled").isChecked(), false);
        await page.locator("#homeButton").click();
        await page.locator("#new").click();
        assert.equal(await page.locator("#queueEnabled").isChecked(), false);
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
