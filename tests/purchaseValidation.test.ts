import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizePurchaseConfig } from "../src/core/purchaseValidation.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";

test("CLI 忽略舊幣種及價格，內部只保留活動名稱且不修改原輸入", () => {
    const target = fixtureConfig.targets[0]!;
    for (const currency of [undefined, "TWD", "HKD", "USD", null]) {
        const expectation = { ...target.expectation, currency, unitPrice: -1, totalPrice: NaN };
        const input = { ...fixtureConfig, targets: [{ ...target, expectation }] };
        assert.deepEqual(normalizePurchaseConfig(input), fixtureConfig);
        assert.equal(input.targets[0]!.expectation.unitPrice, -1);
    }
});

test("移除價格後，活動名稱及票數無效仍在啟動前拒絕", () => {
    const target = fixtureConfig.targets[0]!;
    for (const change of [
        { expectation: { eventName: "" } },
        { quantity: 0 },
        { quantity: 1.5 },
        { date: "2026-02-30" },
        { time: "25:00" },
        { area: "" },
    ]) {
        assert.throws(() => normalizePurchaseConfig({ ...fixtureConfig, targets: [{ ...target, ...change }] }));
    }
});
