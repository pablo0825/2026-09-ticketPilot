import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { parseTicketPlusActivity, ticketPlusSessionSelection } from "../src/config/ticketPlusActivity.js";
import { ActivityStore } from "../src/storage/activityStore.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { startLocalServer } from "../src/local/server.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";

const activity = {
    platform: "ticketplus" as const,
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "相容測試",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "A區", quantity: 2 }],
};
const schedule = { saleAt: "2026-10-20T12:00:00+08:00", advanceSeconds: 1 as const };
const activityId = "a06c1da2-d2c1-484b-af37-5c087da6a5ac";
const requestId = "10ffb74a-5f3b-4b93-8e83-a4cd5d177abd";
// 歷史預期值獨立固定，不用待測 parser／指紋函式產生答案。
const historyHashes = [
    {
        version: 4,
        fingerprint: "7aeb0472a9b3dd2cb3aeca5a54f98f220a4196d576a00483242c53a9b893b6d2",
        settingsHash: "ba421aeacbfa5f52908bce13ea14cde9d22e70a3847bf5ed009fbdf4967f4723",
    },
    {
        version: 5,
        fingerprint: "4d1ed47a806ae775c18bccb793aca6a03b81a44beaa903fb7654271076c5785a",
        settingsHash: "bd5c2176361a4c39b032c9645ac97e356af73718f268c6262eddd02881aff233",
    },
];
function record(hashes: (typeof historyHashes)[number]) {
    return {
        fingerprintVersion: hashes.version,
        fingerprint: hashes.fingerprint,
        activity: { id: activityId, settingsHash: hashes.settingsHash },
        snapshot: {
            platform: "ticketplus",
            id: "123-history",
            requestId,
            activityName: "相容測試",
            status: "unknown",
            browserOpen: false,
            occupied: false,
            message: "原結果不明",
            events: [],
            historyTruncated: false,
        },
    };
}

test("排程設定：省略提前秒數保持原始形狀，完整台灣時間且不改演出時間", () => {
    assert.deepEqual(parseTicketPlusActivity(activity), activity);
    assert.equal("saleSchedule" in parseTicketPlusActivity(activity), false);
    assert.deepEqual(parseTicketPlusActivity({ ...activity, saleSchedule: { saleAt: schedule.saleAt } }).saleSchedule, {
        saleAt: schedule.saleAt,
    });
    for (const advanceSeconds of [1, 2] as const) {
        const input = { ...activity, saleSchedule: { saleAt: "2020-02-29T00:00:00+08:00", advanceSeconds } };
        const before = structuredClone(input);
        assert.deepEqual(parseTicketPlusActivity(input), before);
        assert.deepEqual(input, before);
    }
    for (const bad of [
        null,
        {},
        { advanceSeconds: 1 },
        ...[0, 3, -1, 1.5, "1", null].map(advanceSeconds => ({ ...schedule, advanceSeconds })),
        ...[
            "2026-02-30T12:00:00+08:00",
            "2026-10-20T12:00:00",
            "2026-10-20T04:00:00Z",
            "",
            "2026-10-20T12:00+08:00",
        ].map(saleAt => ({ ...schedule, saleAt })),
        { ...schedule, extra: true },
    ])
        assert.throws(() => parseTicketPlusActivity({ ...activity, saleSchedule: bad }));
});

test("排程不被舊指紋投影丟掉；無排程 v4／v5 指紋及原紀錄保持不變", async t => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-22T12:00:00+08:00"));
    for (const hashes of historyHashes) {
        const dir = await mkdtemp(join(tmpdir(), "tp-schedule-history-"));
        try {
            await mkdir(join(dir, "runs"));
            const file = join(dir, "runs", requestId + ".json");
            const original = JSON.stringify(record(hashes));
            await writeFile(file, original);
            const runs = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
            const saved = {
                id: activityId,
                schemaVersion: 3 as const,
                updatedAt: "2026-10-14T00:00:00.000Z",
                settings: activity,
            };
            assert.equal(runs.start(requestId, activity, activityId).id, "123-history");
            assert.equal(runs.activityStatus(saved), "已執行");
            for (const advanceSeconds of [1, 2] as const) {
                const scheduled = { ...activity, saleSchedule: { ...schedule, advanceSeconds } };
                assert.throws(() => runs.start(requestId, scheduled, activityId), /更換設定/);
                assert.equal(runs.activityStatus({ ...saved, settings: scheduled }), "設定已更新");
                assert.throws(() => runs.start(randomUUID(), scheduled, activityId), /10～1440/);
                assert.throws(
                    () => runs.start(randomUUID(), { ...scheduled, maxRunMinutes: 10 }, activityId),
                    /開賣等待時間已過/,
                );
            }
            assert.equal(await readFile(file, "utf8"), original);
            assert.deepEqual(await readdir(join(dir, "runs")), [requestId + ".json"]);
            assert(!purchaseOccupied(dir));
            assert(!runs.busy());
            await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
            runs.close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

test("排程設定省略及明確提前 1／2 秒都能通過場次能力檢查", () => {
    for (const advanceSeconds of [undefined, 1, 2] as const) {
        const saleSchedule =
            advanceSeconds === undefined ? { saleAt: schedule.saleAt } : { ...schedule, advanceSeconds };
        const settings = { ...activity, saleSchedule };
        assert.deepEqual(parseTicketPlusActivity(settings), settings);
        assert.deepEqual(ticketPlusSessionSelection(settings), {
            platform: "ticketplus",
            eventUrl: activity.eventUrl,
            eventName: activity.eventName,
            target: activity.targets[0],
        });
    }
});

test("API 排程可保存重讀；提前秒數與時間皆比對，過期啟動不留副作用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-schedule-api-"));
    const runtime = join(dir, "runtime");
    const store = new ActivityStore(join(dir, "events"));
    const service = await startLocalServer(store, {
        runDirectory: runtime,

        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const request = (path: string, method = "GET", body?: unknown) =>
            fetch(service.url + path, {
                method,
                headers: { "X-Local-Token": token, "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        const expiredSchedule = { ...schedule, saleAt: "2020-10-20T12:00:00+08:00" };
        const settings = { ...activity, maxRunMinutes: 10, saleSchedule: expiredSchedule };
        const created = await request("/api/activities", "POST", settings);
        assert.equal(created.status, 201);
        const saved = await created.json();
        assert.deepEqual((await store.load(saved.id)).settings, settings);
        const twoSeconds = { ...settings, saleSchedule: { ...expiredSchedule, advanceSeconds: 2 } };
        const updated = await request("/api/activities/" + saved.id, "PUT", twoSeconds);
        assert.equal(updated.status, 200);
        assert.deepEqual((await updated.json()).settings, twoSeconds);
        const file = join(dir, "events", saved.id + ".json");
        const bytes = await readFile(file, "utf8");
        assert.deepEqual(JSON.parse(bytes).settings, twoSeconds);
        assert.deepEqual((await (await request("/api/activities/" + saved.id)).json()).settings, twoSeconds);
        const invalid = await request("/api/activities/" + saved.id, "PUT", {
            ...activity,
            saleSchedule: { ...schedule, advanceSeconds: 3 },
        });
        assert.equal(invalid.status, 400);
        assert.equal(await readFile(file, "utf8"), bytes);
        // 設定不符優先報錯，吻合則被開賣等待期限擋住；不能提前開購票程序。
        for (const expectedActivity of [
            settings,
            { ...twoSeconds, saleSchedule: { ...twoSeconds.saleSchedule, saleAt: "2026-10-21T12:00:00+08:00" } },
            twoSeconds,
        ]) {
            const response = await request("/api/purchase", "POST", {
                requestId: randomUUID(),
                activityId: saved.id,
                expectedActivity,
            });
            assert.equal(response.status, 400);
            const error = await response.json();
            assert.match(error.error, expectedActivity === twoSeconds ? /開賣等待時間已過/ : /已變更/);
            assert.equal(error.notAccepted, true);
        }
        assert.equal((await request("/api/activities")).status, 200);
        assert(!purchaseOccupied(runtime));
        assert.deepEqual(await readdir(join(runtime, "runs")), []);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("固定 v5 排程紀錄：同請求重播先於啟動限制，改時間或提前秒數皆拒絕", async t => {
    t.mock.method(Date, "now", () => Date.parse("2026-10-22T12:00:00+08:00"));
    const dir = await mkdtemp(join(tmpdir(), "tp-schedule-fingerprint-"));
    try {
        await mkdir(join(dir, "runs"));
        // 人工準備歷史紀錄來驗證指紋契約；確認已截止的同請求仍優先重播。
        const original = JSON.stringify(
            record({
                version: 5,
                fingerprint: "4a9ebbdf494c85601bc585256d49ca92d9726dd4367be863c8a403c67934e123",
                settingsHash: "5d6525ffb55497678212eba7dbf366d2b00c6f7b040e577f3bbb9cb33449370c",
            }),
        );
        const file = join(dir, "runs", requestId + ".json");
        await writeFile(file, original);
        const runs = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
        const scheduled = { ...activity, saleSchedule: schedule };
        const saved = {
            id: activityId,
            schemaVersion: 3 as const,
            updatedAt: "2026-10-14T00:00:00.000Z",
            settings: scheduled,
        };
        assert.equal(runs.start(requestId, scheduled, activityId).id, "123-history");
        assert.equal(runs.activityStatus(saved), "已執行");
        assert.throws(() => runs.start(randomUUID(), scheduled, activityId), /10～1440/);
        assert.throws(
            () => runs.start(randomUUID(), { ...scheduled, maxRunMinutes: 10 }, activityId),
            /開賣等待時間已過/,
        );
        for (const saleSchedule of [
            { ...schedule, advanceSeconds: 2 as const },
            { ...schedule, saleAt: "2026-10-21T12:00:00+08:00" },
        ]) {
            const changed = { ...activity, saleSchedule };
            assert.throws(() => runs.start(requestId, changed, activityId), /更換設定/);
            assert.equal(runs.activityStatus({ ...saved, settings: changed }), "設定已更新");
        }
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
