import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createSettingsParser, parsePlatformSettings } from "../src/config/platforms.js";
import { parseTicketPlusActivity, type TicketPlusActivitySettings } from "../src/config/ticketPlusActivity.js";
const other = z.object({ platform: z.literal("fixture"), code: z.number().int() }).strict();
type Other = z.infer<typeof other>;

test("設定登記處分派不同形狀，正式入口拒絕測試平台及未知平台", () => {
    const parse = createSettingsParser<TicketPlusActivitySettings | Other>([
        { id: "ticketplus", parse: parseTicketPlusActivity },
        { id: "fixture", parse: value => other.parse(value) },
    ]);
    assert.deepEqual(parse({ platform: "fixture", code: 3 }), { platform: "fixture", code: 3 });
    assert.throws(() => parse({ platform: "fixture", targets: [] }));
    assert.throws(() => parse({ platform: "unknown" }));
    assert.throws(() => parsePlatformSettings({ platform: "fixture", code: 3 }));
    const wrong = createSettingsParser<TicketPlusActivitySettings | Other>([
        { id: "ticketplus", parse: () => ({ platform: "fixture", code: 3 }) },
    ]);
    assert.throws(() => wrong({ platform: "ticketplus" }), /平台不符/);
});
