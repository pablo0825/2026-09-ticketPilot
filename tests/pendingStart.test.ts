import assert from "node:assert/strict";
import { test } from "node:test";
import {
    pendingStartKey,
    legacyTicketPlusPendingKey,
    hasPendingStart,
    readPendingStart,
    createPendingStart,
    clearPendingStart,
    matchesPendingRun,
} from "../src/local/react/shared/runs/pendingStart.js";
import type { PurchaseSnapshot } from "../src/shared/runSnapshot.js";

function storage() {
    const entries = new Map<string, string>();
    return {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
        removeItem: (key: string) => {
            entries.delete(key);
        },
    };
}
const input = {
    platform: "ticketplus",
    requestId: "original-request",
    activityId: "activity",
    signature: "unchanged-settings",
};

test("共用 pending 使用 v2，其他平台不能覆寫未確認請求", () => {
    const store = storage();
    const pending = createPendingStart(input, store);
    assert.equal(hasPendingStart(store), true);
    assert.deepEqual(JSON.parse(store.getItem(pendingStartKey)!), { version: 2, ...input });
    assert.equal(store.getItem(legacyTicketPlusPendingKey), null);
    assert.throws(() => createPendingStart({ ...input, platform: "fixture" }, store), /尚待確認/);
    assert.deepEqual(readPendingStart(store), pending);
    clearPendingStart(pending, store);
    assert.equal(hasPendingStart(store), false);
});

test("舊 TicketPlus pending 保留原文、request ID 及缺值設定直到明確核對", () => {
    const store = storage();
    const raw = '{ "version": 1, "requestId": "old", "activityId": "activity", "signature": "{old-settings}" }';
    store.setItem(legacyTicketPlusPendingKey, raw);
    const pending = readPendingStart(store);
    assert.ok(pending);
    assert.equal(pending.platform, "ticketplus");
    assert.equal(pending.requestId, "old");
    assert.equal(store.getItem(legacyTicketPlusPendingKey), raw);
    assert.equal(store.getItem(pendingStartKey), null);
    clearPendingStart(pending, store);
    assert.equal(store.getItem(legacyTicketPlusPendingKey), null);
});

test("損壞、版本不符、缺少平台的 pending 仍阻止新增且不清除", () => {
    for (const raw of [
        "broken",
        "null",
        JSON.stringify({ version: 1, ...input }),
        JSON.stringify({ version: 2, ...input, platform: "" }),
    ]) {
        const store = storage();
        store.setItem(pendingStartKey, raw);
        assert.equal(hasPendingStart(store), true);
        assert.throws(() => readPendingStart(store), /無法讀取/);
        assert.throws(() => createPendingStart(input, store), /尚待確認/);
        assert.equal(store.getItem(pendingStartKey), raw);
    }
});

test("未知平台 pending 保留身份並阻止 TicketPlus 建立新請求", () => {
    const store = storage();
    const pending = createPendingStart({ ...input, platform: "future-platform" }, store);
    assert.equal(readPendingStart(store)?.platform, "future-platform");
    assert.throws(() => createPendingStart(input, store), /尚待確認/);
    assert.equal(store.getItem(pendingStartKey), pending.source.raw);
});

test("兩個 pending key 同時存在時不猜測、不清除，也不忽略損壞紀錄", () => {
    const store = storage();
    createPendingStart(input, store);
    store.setItem(legacyTicketPlusPendingKey, "broken");
    assert.throws(() => readPendingStart(store), /多筆/);
    assert.throws(() => createPendingStart(input, store), /尚待確認/);
    assert.ok(store.getItem(pendingStartKey));
    assert.equal(store.getItem(legacyTicketPlusPendingKey), "broken");
});

test("舊回應不能清除替換後的新 pending，也不讀寫 Klook key", () => {
    const store = storage();
    store.setItem("ticketpilot-purchase-request", "archived");
    assert.equal(hasPendingStart(store), false);
    const pending = createPendingStart(input, store);
    const replacement = JSON.stringify({ version: 2, ...input, requestId: "replacement" });
    store.setItem(pendingStartKey, replacement);
    assert.throws(() => clearPendingStart(pending, store), /已變更/);
    assert.equal(store.getItem(pendingStartKey), replacement);
    assert.equal(store.getItem("ticketpilot-purchase-request"), "archived");
});

test("核對啟動結果同時檢查平台、request ID 與有效執行 ID", () => {
    const pending = createPendingStart(input, storage());
    const run: PurchaseSnapshot = {
        id: "run",
        requestId: input.requestId,
        activityName: "fixture",
        platform: "ticketplus",
        status: "running",
        occupied: true,
        browserOpen: false,
        message: "",
        historyTruncated: false,
        events: [],
    };
    assert.equal(matchesPendingRun(run, pending), true);
    assert.equal(matchesPendingRun(null, pending), false);
    assert.equal(matchesPendingRun({ ...run, platform: null }, pending), false);
    assert.equal(matchesPendingRun({ ...run, requestId: "different" }, pending), false);
    assert.equal(matchesPendingRun({ ...run, id: "" }, pending), false);
});

test("等待回應時另一個 key 出現，明確回應也不能清除衝突紀錄", () => {
    const store = storage();
    const pending = createPendingStart(input, store);
    store.setItem(legacyTicketPlusPendingKey, JSON.stringify({ version: 1, ...input }));
    assert.throws(() => clearPendingStart(pending, store), /多筆/);
    assert.equal(store.getItem(pendingStartKey), pending.source.raw);
    assert.ok(store.getItem(legacyTicketPlusPendingKey));
});
