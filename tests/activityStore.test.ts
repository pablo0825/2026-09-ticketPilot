import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseActivity } from "../src/config/activitySettings.js";
import { ActivityStore } from "../src/storage/activityStore.js";
import { parseTicketPlusActivity } from "../src/config/platforms/ticketplus/activitySettings.js";

const activity = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "測試活動",
    targets: [
        { date: "2026-11-02", time: "19:30", ticketType: "B區", quantity: 2 },
        { date: "2026-11-02", time: "19:30", ticketType: "C區", quantity: 1 },
    ],
};

test("活動解析保持 TicketPlus 欄位順序與選項，不補預設流程或期限", () => {
    for (const input of [activity, { ...activity, flowType: "lottery", maxRunMinutes: 30 }]) {
        assert.equal(JSON.stringify(parseActivity(input)), JSON.stringify(parseTicketPlusActivity(input)));
    }
    for (const value of [
        null,
        {},
        { ...activity, eventName: 123 },
        { ...activity, platform: "klook" },
        { ...activity, platform: "unknown" },
        { ...activity, targets: [{ ...activity.targets[0], quantity: "2" }] },
        { ...activity, targets: [{ ...activity.targets[0], date: "2026-02-30" }] },
        { ...activity, targets: [{ ...activity.targets[0], quantity: Number.MAX_SAFE_INTEGER + 1 }] },
        { ...activity, eventUrl: "https://ticketplus.com.tw.evil.example/activity/fixture" },
        { ...activity, saleSchedule: { saleAt: "2026-11-01T10:00:00" } },
        { ...activity, unexpected: true },
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
        const before = await readFile(join(dir, `${a.id}.json`), "utf8");
        await assert.rejects(store.save({}, a.id));
        assert.equal(await readFile(join(dir, `${a.id}.json`), "utf8"), before);
        assert.equal((await store.load(a.id)).settings.eventName, "更新活動");
        await assert.rejects(store.save(activity, randomUUID()));
        await assert.rejects(store.load("../../contact.local"));
        await writeFile(join(dir, "corrupt.json"), "{broken");
        await writeFile(join(dir, `${b.id}.json`), JSON.stringify({ ...b, schemaVersion: 99 }));
        const result = await store.list();
        assert.equal(result.activities.length, 1);
        assert.equal(result.invalidFiles, 2);
        await store.remove(a.id);
        await assert.rejects(store.load(a.id));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
