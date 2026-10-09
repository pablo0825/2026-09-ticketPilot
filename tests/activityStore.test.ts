import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore, parseActivity, toPurchaseConfig } from "../src/config/activityStore.js";
import { saveContactDetails } from "../src/config/contact.config.js";

export const activity = {
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "測試活動",
    fallbackMode: "STRICT",
    excludeKeywords: ["身障"],
    targets: [
        { date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 2, adjacent: true },
        { date: "2026-11-03", time: "18:00", area: "C區", unitPrice: 4880, quantity: 1, adjacent: false },
    ],
};

test("活動格式驗證、順位轉換與計算總價保留核心條件", () => {
    const config = toPurchaseConfig(parseActivity(activity));
    assert.deepEqual(
        config.targets.map(t => [t.date, t.area, t.expectation.totalPrice]),
        [
            ["2026-11-02", "B區", 10560],
            ["2026-11-03", "C區", 4880],
        ],
    );
    assert.equal(config.targets[0]!.expectation.eventName, activity.eventName);
    for (const value of [
        null,
        {},
        { ...activity, eventName: 123 },
        { ...activity, fallbackMode: "ANY" },
        { ...activity, targets: [{ ...activity.targets[0], quantity: "2" }] },
        { ...activity, targets: [{ ...activity.targets[0], date: "2026-02-30" }] },
        { ...activity, targets: [{ ...activity.targets[0], area: "身障" }] },
        { ...activity, targets: [{ ...activity.targets[0], unitPrice: Number.MAX_SAFE_INTEGER }] },
        { ...activity, eventUrl: "https://www.klook.com.evil.example/zh-TW/event-detail/a/" },
        { ...activity, saleSchedule: { saleAt: "2026-11-01T10:00:00" } },
    ])
        assert.throws(() => parseActivity(value));
});

test("新增不覆蓋同名活動；修改失敗保留舊檔；損壞與版本不符明確列出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-activities-"));
    try {
        const store = new ActivityStore(dir);
        const a = await store.save(activity);
        const b = await store.save(activity);
        assert.notEqual(a.id, b.id);
        await store.save({ ...activity, eventName: "更新活動" }, a.id);
        assert.equal((await store.load(b.id)).settings.eventName, activity.eventName);
        await assert.rejects(store.save({}, a.id));
        assert.equal((await store.load(a.id)).settings.eventName, "更新活動");
        await assert.rejects(store.load("../../contact.local"));
        await writeFile(join(dir, "corrupt.json"), "{broken");
        await writeFile(join(dir, `${b.id}.json`), JSON.stringify({ ...b, schemaVersion: 99 }));
        const result = await store.list();
        assert.equal(result.activities.length, 1);
        assert.equal(result.invalidFiles, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("個資保存共用驗證，錯誤輸入不覆蓋原檔", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-contact-"));
    const path = join(dir, "contact.local.json");
    try {
        const data = {
            firstName: "Demo",
            lastName: "Test",
            regionLabel: "台灣 (+886)",
            phone: "0912345678",
            email: "fixture@example.com",
        };
        await saveContactDetails(data, path);
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), data);
        await assert.rejects(saveContactDetails({}, path));
        assert.deepEqual(JSON.parse(await readFile(path, "utf8")), data);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
