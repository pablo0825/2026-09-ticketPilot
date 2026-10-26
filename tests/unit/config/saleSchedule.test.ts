import assert from "node:assert/strict";
import { test } from "node:test";
import { validateSaleSchedule } from "../../../src/core/saleSchedule.js";

const saleAt = "2026-10-10T10:00:00+08:00";
const sale = Date.parse(saleAt);

test("排程設定拒絕錯誤日期、缺少時區及不支援的提前量", () => {
    assert.equal(validateSaleSchedule({ saleAt }), sale);
    for (const value of ["2026-02-30T10:00:00+08:00", "2026-10-10T10:00:00", "2026-10-10T24:00:00+08:00", "bad"]) {
        assert.throws(() => validateSaleSchedule({ saleAt: value }));
    }
    assert.throws(() => validateSaleSchedule({ saleAt, advanceSeconds: 0 as 1 }));
});

test("排程格式完整匹配，提前量只接受一或二秒", () => {
    for (const advanceSeconds of [1, 2] as const) {
        assert.equal(validateSaleSchedule({ saleAt, advanceSeconds }), sale);
    }
    for (const value of ["prefix" + saleAt, saleAt + "suffix", " " + saleAt, saleAt + "\n"]) {
        assert.throws(() => validateSaleSchedule({ saleAt: value }));
    }
    for (const advanceSeconds of [-1, 3, 1.5, NaN, Infinity]) {
        // JSON/外部呼叫可能帶入型別之外的數值，必須在執行期拒絕。
        assert.throws(() => validateSaleSchedule({ saleAt, advanceSeconds: advanceSeconds as 1 }), {
            message: "提前刷新只能設定 1 或 2 秒。",
        });
    }
});
