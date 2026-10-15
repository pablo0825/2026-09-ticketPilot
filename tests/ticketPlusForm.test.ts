import assert from "node:assert/strict";
import { test } from "node:test";
import {
    activityForm,
    activityInput,
    executionForm,
    executionInput,
    draftFingerprint,
    ticketPlusRecord,
} from "../src/local/react/platforms/ticketplus/formModel.js";
import type { TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";

const settings: TicketPlusActivitySettings = {
    platform: "ticketplus",
    eventName: "表單測試",
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    targets: [{ date: "2026-11-22", time: "18:00", ticketType: "A區", quantity: 2 }],
    saleSchedule: { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 },
    maxRunMinutes: 10,
};

test("TicketPlus 表單：明列儲存欄位，保留唯讀排程與跨場次設定", () => {
    const form = activityForm(settings);
    form.eventName = " 修改活動 ";
    form.targets.push({ key: "UI-ONLY", date: "2026-11-23", time: "19:00", ticketType: " B區 ", quantity: "3" });
    assert.deepEqual(activityInput(form, settings), {
        platform: "ticketplus",
        eventName: "修改活動",
        eventUrl: "https://ticketplus.com.tw/activity/fixture",
        targets: [
            { date: "2026-11-22", time: "18:00", ticketType: "A區", quantity: 2 },
            { date: "2026-11-23", time: "19:00", ticketType: "B區", quantity: 3 },
        ],
        saleSchedule: { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 },
        maxRunMinutes: 10,
    });
    assert.equal(settings.maxRunMinutes, 10);
});

test("TicketPlus 執行設定：必填期限、上下限接受，其餘數值拒絕", () => {
    const form = executionForm(settings);
    for (const minutes of [10, 1440]) {
        form.maxRunMinutes = String(minutes);
        assert.equal(executionInput(form, settings).maxRunMinutes, minutes);
    }
    for (const text of ["", "  ", "0", "9", "-1", "10.5", "1441", "NaN", "abc"]) {
        form.maxRunMinutes = text;
        assert.throws(() => executionInput(form, settings), /最長執行時間/);
    }
    const activity = activityForm(settings);
    for (const quantity of ["", "0", "-1", "1.5", "abc", "9007199254740992"]) {
        activity.targets[0]!.quantity = quantity;
        assert.throws(() => activityInput(activity), /張數/);
    }
});

test("TicketPlus 表單：草稿比較不依賴 UUID 或儲存驗證，改回原值解除 dirty", () => {
    const empty = activityForm();
    assert.equal(draftFingerprint(empty), draftFingerprint(activityForm()));
    const form = activityForm(settings);
    const baseline = draftFingerprint(form);
    form.targets[0]!.key = "new-key";
    assert.equal(draftFingerprint(form), baseline);
    form.targets[0]!.quantity = "";
    assert.notEqual(draftFingerprint(form), baseline);
    form.targets[0]!.quantity = "2";
    assert.equal(draftFingerprint(form), baseline);
});

test("TicketPlus 表單：API 回應須核對平台、ID 與版本", () => {
    const record = { schemaVersion: 3, id: "fixture", updatedAt: "2026-10-15T00:00:00.000Z", settings };
    assert.equal(ticketPlusRecord(record, "fixture").settings.platform, "ticketplus");
    assert.throws(() => ticketPlusRecord(record, "different"));
    assert.throws(() => ticketPlusRecord({ ...record, settings: { ...settings, platform: "klook" } }));
    assert.throws(() => ticketPlusRecord({ ...record, updatedAt: "invalid" }));
    assert.throws(() => ticketPlusRecord(null));
});

test("TicketPlus 期限表單：新活動與舊缺值預填 10，讀取不修改來源，舊低值不偷偷延長", () => {
    assert.equal(executionForm().maxRunMinutes, "10");
    const { maxRunMinutes: _duration, ...legacy } = settings;
    const before = JSON.stringify(legacy);
    assert.equal(executionForm(legacy).maxRunMinutes, "10");
    assert.equal(JSON.stringify(legacy), before);
    assert.equal(executionInput(executionForm(legacy), legacy).maxRunMinutes, 10);
    for (const minutes of [1, 5, 9]) {
        const old = { ...legacy, maxRunMinutes: minutes };
        const form = executionForm(old);
        assert.equal(form.maxRunMinutes, String(minutes));
        assert.throws(() => executionInput(form, old), /最長執行時間/);
        assert.equal(old.maxRunMinutes, minutes);
    }
});
