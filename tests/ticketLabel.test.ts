import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTicketLabel } from "../src/platforms/klook/ticketLabel.js";

test("解析已觀察的價格後綴，保留票種限定文字", () => {
    for (const text of ["A區（NT$3,000）", "A區 NT$3000", "A區 $3,000", " Ａ區（NT＄３,０００） "]) {
        assert.deepEqual(parseTicketLabel(text), { name: "A區", unitPrice: 3000 });
    }
    assert.deepEqual(parseTicketLabel("獨立靠近(單人票) NT$1280"), { name: "獨立靠近(單人票)", unitPrice: 1280 });
});

test("拒絕錯誤千分位、小數、未知格式與無效金額", () => {
    for (const text of ["A區 NT$48,80", "A區 NT$3000.5", "A區 3000", "A區 NT$3000起", "A區 NT$0", "A區 NT$9007199254740992", "A區（NT$3,000", "NT$3000"]) {
        assert.throws(() => parseTicketLabel(text), text);
    }
});
