import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTicketLabel } from "../src/platforms/klook/ticketLabel.js";

test("價格後綴只用來辨識名稱，不核對幣種、金額或千分位", () => {
    for (const text of [
        "A區（NT$3,000）",
        "A區 HK$50.5",
        "A區 $3,000",
        " Ａ區（NT＄３,０００） ",
        "A區 USD48,80",
        "A區 €0",
        "A區 NT$9007199254740992",
        "A區 NT$3000起",
        "A區",
    ]) {
        assert.deepEqual(parseTicketLabel(text), { name: "A區" });
    }
});

test("保留括號、VIP與票區數字；不明後綴不可偷偷變成另一票種", () => {
    for (const name of ["獨立靠近(單人票)", "B區VIP", "B1區", "B區VIP2", "B區 VIP2", "B區(優惠方案二)"]) {
        assert.deepEqual(parseTicketLabel(name), { name: name.replace(/\s/g, "") });
        assert.deepEqual(parseTicketLabel(`${name} (HK$1,280)`), { name: name.replace(/\s/g, "") });
    }
    for (const text of ["A區 3000", "A區（NT$3,000", "A區（未知方案）", "A區 NT$待定"]) {
        assert.notEqual(parseTicketLabel(text).name, "A區");
    }
    for (const text of ["", "　"]) assert.throws(() => parseTicketLabel(text));
});

test("純金額票種保留完整名稱，只正規化全半形與空白", () => {
    for (const text of ["NT$6,980", " NT$ 6,980 ", "ＮＴ＄６，９８０"]) {
        assert.deepEqual(parseTicketLabel(text), { name: "NT$6,980" });
    }
    for (const text of ["NT$4,980", "HK$6,980", "NT$6980", "NT$6,980起", "NT$6,980 - 內場", "NT$6,980 - 看台"]) {
        assert.notEqual(parseTicketLabel(text).name, "NT$6,980");
    }
    assert.equal(parseTicketLabel("NT$8,380 - 內場").name, "NT$8,380-內場");
    assert.equal(parseTicketLabel("NT$8,380 - 看台").name, "NT$8,380-看台");
});
