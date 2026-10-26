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
