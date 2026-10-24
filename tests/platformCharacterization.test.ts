import type { ActivityRecord } from "../src/shared/activityRecord.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { parseActivity } from "../src/config/activitySettings.js";

const settings = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "相容測試",
    targets: [
        { date: "2027-01-01", time: "20:00", ticketType: "A", quantity: 2 },
        { date: "2027-01-01", time: "20:00", ticketType: "B", quantity: 2 },
    ],
    maxRunMinutes: 10,
    saleSchedule: { saleAt: "2027-01-01T12:00:00+08:00", advanceSeconds: 2 },
};

for (const [flowType, fingerprint, settingsHash] of [
    [
        "purchase",
        "322400eea178ccab5f13386e80839610bd12e15d90c726268d0291179c1d9213",
        "6611060da767d6572dc87e1074dc1f66a1fae482f6f082edce6b74f05508554c",
    ],
    [
        "lottery",
        "c507a52a4fd8ed2711c7630f0fa2f5c6b79751e8300d1c02b7369f73b0e70f10",
        "de1d3be52bdd0d04a3d3b4e37688e33913e948cfec2f11df6238697a98149aca",
    ],
] as const) {
    test(`多順位排程 ${flowType}：固定歷史指紋重播及設定比對不改寫紀錄`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "platform-characterization-"));
        let runs: PurchaseRuns | undefined;
        try {
            const requestId = randomUUID();
            const activity: ActivityRecord = {
                schemaVersion: 3,
                id: randomUUID(),
                updatedAt: "2026-10-01T00:00:00Z",
                settings: parseActivity({ ...settings, flowType }),
            };
            const snapshot = {
                platform: "ticketplus",
                id: "historical-run",
                requestId,
                activityName: settings.eventName,
                status: "failed",
                browserOpen: false,
                occupied: false,
                message: "已停止",
                events: [],
                historyTruncated: false,
            };
            const raw = JSON.stringify({
                fingerprintVersion: 5,
                fingerprint,
                activity: { id: activity.id, settingsHash },
                snapshot,
            });
            await mkdir(join(directory, "runs"));
            const file = join(directory, "runs", `${requestId}.json`);
            await writeFile(file, raw);
            runs = new PurchaseRuns(directory, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
            assert.equal(runs.start(requestId, activity.settings, activity.id).id, snapshot.id);
            assert.equal(runs.activityStatus(activity), "已執行");
            if (flowType === "purchase") {
                assert.equal(runs.start(requestId, settings, activity.id).id, snapshot.id);
            }
            assert.throws(
                () => runs!.start(requestId, { ...activity.settings, maxRunMinutes: 11 }, activity.id),
                /不能更換設定/,
            );
            assert.equal(
                runs.activityStatus({ ...activity, settings: { ...activity.settings, maxRunMinutes: 11 } }),
                "設定已更新",
            );
            assert.equal(await readFile(file, "utf8"), raw);
        } finally {
            runs?.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
