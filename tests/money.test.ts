import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMoney } from "../src/platforms/klook/money.js";
import { parseTicketLabel } from "../src/platforms/klook/ticketLabel.js";
import { verifyMoney } from "../src/core/currency.js";
import { normalizePurchaseConfig } from "../src/core/purchaseValidation.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";

test("明確台幣港幣符號、全形與千分位可解析；未知幣別、小數或破損格式拒絕", () => {
    assert.deepEqual(parseMoney("HK$ 1,699"), { currency: "HKD", amount: 1699 });
    assert.deepEqual(parseMoney("ＮＴ＄１,６９９"), { currency: "TWD", amount: 1699 });
    for (const value of [
        "$1,699",
        "USD1,699",
        "HK$1,699.00",
        "HK$16,99",
        "HK$0",
        "HK$-1",
        "HK$1,699起",
        "HK$9007199254740992",
    ]) {
        assert.throws(() => parseMoney(value), value);
    }
    for (const label of ["VIP (HK$1,699)", "VIP HK$1699", "ＶＩＰ（ＨＫ＄１,６９９）"]) {
        assert.deepEqual(parseTicketLabel(label), { name: "VIP", currency: "HKD", unitPrice: 1699 });
    }
    assert.deepEqual(parseTicketLabel("VIP $1699"), { name: "VIP", currency: "TWD", unitPrice: 1699 });
    assert.throws(() => parseTicketLabel("VIP ($1699)"));
});

test("同金額錯幣與同幣錯金額都不能通過", () => {
    const expected = { currency: "HKD" as const, amount: 1699 };
    verifyMoney(parseMoney("HK$1,699"), expected);
    assert.throws(() => verifyMoney(parseMoney("NT$1,699"), expected), /幣別/);
    assert.throws(() => verifyMoney(parseMoney("HK$1,799"), expected), /金額/);
});

test("舊 CLI 缺幣別只在入口補台幣；未知與混合幣別啟動前停止", () => {
    const input = structuredClone(fixtureConfig);
    const { currency: _currency, ...legacy } = input.targets[0]!.expectation;
    const config = { ...input, targets: [{ ...input.targets[0]!, expectation: legacy }] };
    assert.equal(normalizePurchaseConfig(config).targets[0]!.expectation.currency, "TWD");
    assert.equal("currency" in config.targets[0]!.expectation, false);
    assert.throws(
        () =>
            normalizePurchaseConfig({
                ...input,
                targets: [input.targets[0]!, { ...input.targets[0]!, expectation: { ...legacy, currency: "HKD" } }],
            }),
        /相同幣別/,
    );
    for (const currency of [null, "USD", "", "__proto__"]) {
        assert.throws(() =>
            normalizePurchaseConfig({
                ...input,
                targets: [{ ...input.targets[0]!, expectation: { ...legacy, currency } }],
            } as never),
        );
    }
});
