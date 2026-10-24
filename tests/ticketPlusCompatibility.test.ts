import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
    parseTicketPlusActivity,
    parseTicketPlusSelection,
} from "../src/config/platforms/ticketplus/activitySettings.js";
import { ActivityStore } from "../src/storage/activityStore.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { startLocalServer } from "../src/local/server.js";
import { runTicketPlus } from "../src/app/flows/ticketplus/runTicketPlus.js";
import { purchaseOccupied } from "../src/storage/purchaseLock.js";

const legacy = {
    platform: "ticketplus" as const,
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "相容測試",
    target: { date: "2026-10-30", time: "20:00", ticketType: "A區", quantity: 2 },
};
// 手寫新舊答案；舊 hash 依修改前的 JSON 格式獨立計算，不呼叫新版 parser／hash helper。
const canonical = {
    platform: "ticketplus" as const,
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "相容測試",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "A區", quantity: 2 }],
};
const second = { date: "2026-10-31", time: "19:30", ticketType: "Ｂ區", quantity: 1 };
const multiple = { ...canonical, targets: [...canonical.targets, second] };
const activityId = "a06c1da2-d2c1-484b-af37-5c087da6a5ac";
const requestId = "10ffb74a-5f3b-4b93-8e83-a4cd5d177abd";
const activityRecord = {
    schemaVersion: 3,
    id: activityId,
    updatedAt: "2026-10-14T00:00:00.000Z",
    settings: canonical,
};
const oldRun = {
    fingerprintVersion: 4,
    fingerprint: "7aeb0472a9b3dd2cb3aeca5a54f98f220a4196d576a00483242c53a9b893b6d2",
    activity: { id: activityId, settingsHash: "ba421aeacbfa5f52908bce13ea14cde9d22e70a3847bf5ed009fbdf4967f4723" },
    snapshot: {
        platform: "ticketplus",
        id: "123-old-run",
        requestId,
        activityName: "相容測試",
        status: "unknown",
        browserOpen: false,
        occupied: false,
        message: "原提交結果不明",
        events: [],
        historyTruncated: false,
    },
};

test("多順位解析：保持順序與重複值、第二筆也驗證，舊輸入不改動", () => {
    const before = structuredClone(legacy);
    assert.throws(() => parseTicketPlusActivity(legacy), /格式錯誤/);
    assert.deepEqual(legacy, before);
    assert.deepEqual(parseTicketPlusActivity(multiple), multiple);
    const reversed = { ...canonical, targets: [second, canonical.targets[0]!] };
    assert.deepEqual(parseTicketPlusActivity(reversed), reversed);
    const repeated = { ...canonical, targets: [canonical.targets[0]!, canonical.targets[0]!] };
    assert.deepEqual(parseTicketPlusActivity(repeated), repeated);
    for (const bad of [
        { ...canonical, target: legacy.target },
        { ...canonical, targets: [] },
        { ...multiple, targets: [legacy.target, { ...second, quantity: 0 }] },
        { ...multiple, targets: [legacy.target, { ...second, date: "2026-02-30" }] },
        { ...canonical, saleSchedule: { saleAt: "2026-10-30T12:00:00+08:00", advanceSeconds: 0 } },
    ])
        assert.throws(() => parseTicketPlusActivity(bad), /格式錯誤/);
    assert.throws(() => parseTicketPlusSelection(multiple), /格式錯誤/);
});

test("活動只讀不改檔；保存保留 ID 與多順位順序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-format-"));
    try {
        const file = join(dir, activityId + ".json");
        const original = JSON.stringify(activityRecord, null, 2) + "\n";
        await writeFile(file, original);
        const store = new ActivityStore(dir);
        assert.deepEqual((await store.load(activityId)).settings, canonical);
        await store.list();
        assert.equal(await readFile(file, "utf8"), original);
        const updated = await store.save(multiple, activityId);
        assert.equal(updated.id, activityId);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")).settings, multiple);
        assert.deepEqual((await store.load(activityId)).settings, multiple);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("舊 TP v4 請求與活動狀態：等價單順位重播原結果，改設定拒絕，零啟動", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-history-"));
    try {
        await mkdir(join(dir, "runs"));
        const file = join(dir, "runs", requestId + ".json");
        const original = JSON.stringify(oldRun);
        await writeFile(file, original);
        const store = new ActivityStore(join(dir, "events"));
        await mkdir(join(dir, "events"));
        await writeFile(join(dir, "events", activityId + ".json"), JSON.stringify(activityRecord));
        const runs = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
        const result = runs.start(requestId, canonical, activityId);
        assert.equal(result.id, "123-old-run");
        assert.equal(result.status, "unknown");
        assert.equal(runs.activityStatus(await store.load(activityId)), "已執行");
        assert.equal(runs.activityStatus(await store.save(canonical, activityId)), "已執行");
        // 明寫購票等同未寫；改成抽選才算設定變更
        assert.equal(
            runs.activityStatus(await store.save({ ...canonical, flowType: "purchase" }, activityId)),
            "已執行",
        );
        assert.equal(
            runs.activityStatus(await store.save({ ...canonical, flowType: "lottery" }, activityId)),
            "設定已更新",
        );
        for (const input of [
            multiple,
            { ...canonical, targets: [{ ...legacy.target, quantity: 3 }] },
            { ...canonical, flowType: "lottery" as const },
        ]) {
            assert.throws(() => runs.start(requestId, input, activityId), /更換設定/);
            assert.equal(runs.activityStatus(await store.save(input, activityId)), "設定已更新");
        }
        assert.throws(() => runs.start(requestId, legacy, activityId), /格式錯誤/);
        assert(!runs.busy());
        assert(!purchaseOccupied(dir));
        assert.equal(await readFile(file, "utf8"), original);
        assert.deepEqual(await readdir(join(dir, "runs")), [requestId + ".json"]);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
        runs.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("跨場次 runner 拒絕在開瀏覽器前，訊息明確而非默取第一筆", async t => {
    const dir = await mkdtemp(join(tmpdir(), "tp-guard-"));
    const launch = t.mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("must not launch");
    });
    try {
        // 無效 lease 若被驗證會先報鎖錯誤；能力限制必須比取得／驗證 lease 更早。
        await assert.rejects(
            runTicketPlus(multiple, {
                lease: { path: join(dir, "missing.lock"), token: "invalid" } as never,
            }),
            /只支援同場次多順位/,
        );
        assert.equal(launch.mock.callCount(), 0);
        assert.deepEqual(await readdir(dir), []);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("API 可保存跨場次順位但啟動零副作用；新單順位可重播舊紀錄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-api-compat-"));
    const runtime = join(dir, "runtime");
    const store = new ActivityStore(join(dir, "events"));
    await mkdir(join(dir, "events"));
    await writeFile(join(dir, "events", activityId + ".json"), JSON.stringify(activityRecord));
    await mkdir(join(runtime, "runs"), { recursive: true });
    await writeFile(join(runtime, "runs", requestId + ".json"), JSON.stringify(oldRun));
    const service = await startLocalServer(store, {
        runDirectory: runtime,

        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const post = (path: string, value: unknown) =>
            fetch(service.url + path, {
                method: "POST",
                headers: { "X-Local-Token": token, "Content-Type": "application/json" },
                body: JSON.stringify(value),
            });
        await store.save(canonical, activityId);
        const replay = await post("/api/purchase", { requestId, activityId, expectedActivity: canonical });
        assert.equal(replay.status, 200);
        assert.equal((await replay.json()).id, "123-old-run");
        const obsolete = await post("/api/purchase", { requestId, activityId, expectedActivity: legacy });
        assert.equal(obsolete.status, 400);
        assert.equal((await obsolete.json()).notAccepted, false);
        const savedResponse = await post("/api/activities", multiple);
        assert.equal(savedResponse.status, 201);
        const saved = await savedResponse.json();
        assert.deepEqual(saved.settings, multiple);
        const response = await post("/api/purchase", {
            requestId: randomUUID(),
            activityId: saved.id,
            expectedActivity: multiple,
        });
        assert.equal(response.status, 400);
        const rejected = await response.json();
        assert.match(rejected.error, /只支援同場次多順位/);
        assert.equal(rejected.notAccepted, true);
        assert(!purchaseOccupied(runtime));
        assert.deepEqual(await readdir(join(runtime, "runs")), [requestId + ".json"]);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("舊 target 活動檔列為無效且不能更新／刪除，原始檔保持不變", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-obsolete-"));
    try {
        const file = join(dir, activityId + ".json");
        const original = JSON.stringify({ ...activityRecord, settings: legacy });
        await writeFile(file, original);
        const store = new ActivityStore(dir);
        assert.deepEqual(await store.list(), { activities: [], invalidFiles: 1 });
        await assert.rejects(store.load(activityId), /格式錯誤/);
        await assert.rejects(store.save(canonical, activityId), /格式錯誤/);
        await assert.rejects(store.remove(activityId), /格式錯誤/);
        assert.equal(await readFile(file, "utf8"), original);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("舊 target 不能從 runner 啟動，內部單次 Selection 仍合法", async t => {
    const launch = t.mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("must not launch");
    });
    await assert.rejects(runTicketPlus(legacy as never, {}), /格式錯誤/);
    assert.equal(launch.mock.callCount(), 0);
    assert.deepEqual(parseTicketPlusSelection(legacy), legacy);
});
