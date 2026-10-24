import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ActivityStore } from "../../src/storage/activityStore.js";
import { PurchaseRuns } from "../../src/server/runs/purchaseRuns.js";
import { runTicketPlus } from "../../src/app/flows/ticketplus/runTicketPlus.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lease = { path: join(process.cwd(), "purchase.lock"), token: "isolated-path-probe" };
const activityDirectories: unknown[] = [];
const runDirectoriesCreated: unknown[] = [];
const runDirectoriesRead: unknown[] = [];
const profiles: string[] = [];
const releasedLeases: unknown[] = [];

// 攔截實際 I/O 的參數，避免測試碰到使用者的活動、紀錄、占用鎖或瀏覽器。
mock.method(fsPromises, "readdir", async (path: unknown) => {
    activityDirectories.push(path);
    return [];
});
mock.method(fs, "mkdirSync", (path: unknown) => {
    runDirectoriesCreated.push(path);
});
mock.method(fs, "readdirSync", (path: unknown) => {
    runDirectoriesRead.push(path);
    return [];
});
mock.method(fs, "readFileSync", (path: unknown) => {
    assert.equal(path, lease.path, "只允許讀取測試用占用鎖");
    return JSON.stringify({ token: lease.token });
});
mock.method(fs, "unlinkSync", (path: unknown) => {
    assert.equal(path, lease.path, "只允許釋放測試用占用鎖");
    releasedLeases.push(path);
});
mock.method(chromium, "launchPersistentContext", async (path: string) => {
    profiles.push(path);
    throw new Error("已記錄 profile 路徑，不開啟瀏覽器");
});
syncBuiltinESMExports();

try {
    assert.deepEqual(await new ActivityStore().list(), { activities: [], invalidFiles: 0 });
    assert.deepEqual(activityDirectories, [join(root, "local-data", "events")]);

    new PurchaseRuns();
    assert.deepEqual(runDirectoriesCreated, [join(root, "local-data", "runs")]);
    assert.deepEqual(runDirectoriesRead, [join(root, "local-data", "runs")]);

    const result = await runTicketPlus(
        {
            platform: "ticketplus",
            eventUrl: "https://ticketplus.com.tw/activity/fixture",
            eventName: "預設路徑測試",
            targets: [{ date: "2027-01-01", time: "20:00", ticketType: "A", quantity: 1 }],
            maxRunMinutes: 10,
        },
        { lease },
    );
    assert.equal(result.outcome, "stopped");
    assert.equal(result.reason, "startup-stopped");
    assert.deepEqual(profiles, [join(root, "browser-profile-ticketplus")]);
    assert.deepEqual(releasedLeases, [lease.path]);
} finally {
    mock.restoreAll();
    syncBuiltinESMExports();
}
