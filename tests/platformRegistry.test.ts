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

import { createExecutionRegistry, runSnapshotFields } from "../src/app/platforms/platformDefinition.js";
import type { PlatformDefinition } from "../src/app/platforms/platformDefinition.js";
import { ticketPlusDefinition } from "../src/app/platforms/ticketPlus.js";
import { executionPlatform } from "../src/app/platforms/index.js";
import type { PurchaseEvent } from "../src/shared/runEvents.js";

test("執行登記處分派平台事件，正式入口不提供假平台，平台不能加入控制欄位", () => {
    type Event = PurchaseEvent | { type: "fixture"; count: number };
    const fixture: PlatformDefinition<Event> = {
        ...ticketPlusDefinition,
        id: "fixture",
        name: "Fixture",
        parseEvent(value) {
            const parsed = z
                .object({ type: z.literal("fixture"), count: z.number() })
                .strict()
                .safeParse(value);
            return parsed.success ? parsed.data : undefined;
        },
        waitingForSale: () => false,
    };
    const lookup = createExecutionRegistry<Event>([{ ...ticketPlusDefinition, waitingForSale: () => false }, fixture]);
    assert.deepEqual(lookup("fixture").parseEvent({ type: "fixture", count: 2 }), { type: "fixture", count: 2 });
    assert.equal(lookup("ticketplus").parseEvent({ type: "fixture", count: 2 }), undefined);
    assert.equal(lookup("fixture").parseEvent({ type: "ticketplus", stage: "starting" }), undefined);
    assert.throws(() => executionPlatform("fixture"));
    const fields = { activityName: "Fixture", requestId: "forged", status: "running", occupied: false };
    assert.deepEqual(runSnapshotFields(fields), { activityName: "Fixture" });
});
