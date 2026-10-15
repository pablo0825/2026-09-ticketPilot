import assert from "node:assert/strict";
import { test } from "node:test";
import {
    activityForm,
    activityInput,
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
    form.maxRunMinutes = "";
    assert.deepEqual(activityInput(form, settings), {
        platform: "ticketplus",
        eventName: "修改活動",
        eventUrl: "https://ticketplus.com.tw/activity/fixture",
        targets: [
            { date: "2026-11-22", time: "18:00", ticketType: "A區", quantity: 2 },
            { date: "2026-11-23", time: "19:00", ticketType: "B區", quantity: 3 },
        ],
        saleSchedule: { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 },
    });
    assert.equal(settings.maxRunMinutes, 10);
});

test("TicketPlus 表單：空白期限省略、上下限接受，其餘數值拒絕", () => {
    const form = activityForm(settings);
    for (const text of ["", "  "]) {
        form.maxRunMinutes = text;
        assert(!("maxRunMinutes" in activityInput(form)));
    }
    for (const minutes of [1, 1440]) {
        form.maxRunMinutes = String(minutes);
        assert.equal(activityInput(form).maxRunMinutes, minutes);
    }
    for (const text of ["0", "-1", "1.5", "1441", "NaN", "abc"]) {
        form.maxRunMinutes = text;
        assert.throws(() => activityInput(form), /最長執行時間/);
    }
    form.maxRunMinutes = "";
    for (const quantity of ["", "0", "-1", "1.5", "abc", "9007199254740992"]) {
        form.targets[0]!.quantity = quantity;
        assert.throws(() => activityInput(form), /張數/);
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
