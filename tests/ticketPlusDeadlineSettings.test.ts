import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import {
    parseTicketPlusActivity,
    singleTicketPlusSelection,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
} from "../src/config/platforms/ticketplus/activitySettings.js";
import { ActivityStore } from "../src/storage/activityStore.js";
import { PurchaseRuns } from "../src/server/runs/purchaseRuns.js";
import { startLocalServer } from "../src/local/server.js";
import { runTicketPlus } from "../src/app/flows/ticketplus/runTicketPlus.js";
import { purchaseOccupied } from "../src/storage/purchaseLock.js";

const activity = {
    platform: "ticketplus" as const,
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    eventName: "相容測試",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "A區", quantity: 2 }],
};
const activityId = "a06c1da2-d2c1-484b-af37-5c087da6a5ac";
const requestId = "10ffb74a-5f3b-4b93-8e83-a4cd5d177abd";
// 歷史答案固定，不透過待測 parser 或指紋函式產生。
const histories = [
    {
        version: 5,
        minutes: 5,
        fingerprint: "4d03e276258cfbf53a9fab8111038de26ac5aedbccb4b8aac3195cfb224ab2bb",
        settingsHash: "56018c030f5551538d2b0da8cc2eb4f58248bebebcb6351a005eb4d476a738cb",
    },
    {
        version: 4,
        minutes: undefined,
        fingerprint: "7aeb0472a9b3dd2cb3aeca5a54f98f220a4196d576a00483242c53a9b893b6d2",
        settingsHash: "ba421aeacbfa5f52908bce13ea14cde9d22e70a3847bf5ed009fbdf4967f4723",
    },
    {
        version: 5,
        minutes: undefined,
        fingerprint: "4d1ed47a806ae775c18bccb793aca6a03b81a44beaa903fb7654271076c5785a",
        settingsHash: "bd5c2176361a4c39b032c9645ac97e356af73718f268c6262eddd02881aff233",
    },
    {
        version: 5,
        minutes: 10,
        fingerprint: "efc3e30f26249e66fe94988253696007a4024945756a7b5cceb70cf321a81979",
        settingsHash: "fd2a8f0fc56a935bb9c736370d713be0850e2631a86e8215142566acac46e837",
    },
];

test("最長時間為選填整數 1～1440；不補預設值，不丟棄期限做舊投影", () => {
    assert.deepEqual(parseTicketPlusActivity(activity), activity);
    assert.equal("maxRunMinutes" in parseTicketPlusActivity(activity), false);
    for (const maxRunMinutes of [1, 9, 10, 1440]) {
        const settings = { ...activity, maxRunMinutes };
        assert.deepEqual(parseTicketPlusActivity(settings), settings);
        assert.throws(() => singleTicketPlusSelection(settings), /不能投影/);
        assert.deepEqual(ticketPlusSessionSelection(settings), {
            platform: "ticketplus",
            eventUrl: activity.eventUrl,
            eventName: activity.eventName,
            target: activity.targets[0],
        });
    }
    for (const maxRunMinutes of [0, -1, 1.5, 1441, Infinity, NaN, "10", null, true]) {
        assert.throws(() => parseTicketPlusActivity({ ...activity, maxRunMinutes }), /1～1440/);
    }
});

test("期限錯誤在 runner 取得占用、驗證外部 lease 與開瀏覽器前拒絕", async t => {
    const launch = t.mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("must not launch");
    });
    await assert.rejects(
        runTicketPlus(
            { ...activity, maxRunMinutes: 0 },
            {
                lease: { path: "/missing-ticketplus-deadline.lock", token: "invalid" } as never,
            },
        ),
        /1～1440/,
    );
    assert.equal(launch.mock.callCount(), 0);
});

test("固定 v4／v5 歷史：未填期限保持相容，新增、變更、移除期限皆辨識為設定變更", async () => {
    // 各版紀錄分開載入，避免以目前程式重寫歷史答案。
    for (const history of histories) {
        const dir = await mkdtemp(join(tmpdir(), "tp-deadline-history-"));
        try {
            await mkdir(join(dir, "runs"));
            const file = join(dir, "runs", requestId + ".json");
            const original = JSON.stringify({
                fingerprintVersion: history.version,
                fingerprint: history.fingerprint,
                activity: { id: activityId, settingsHash: history.settingsHash },
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
            });
            await writeFile(file, original);
            const runs = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
            const settings = history.minutes === undefined ? activity : { ...activity, maxRunMinutes: history.minutes };
            const saved = {
                id: activityId,
                schemaVersion: 3 as const,
                updatedAt: "2026-10-14T00:00:00.000Z",
                settings,
            };
            assert.equal(runs.start(requestId, settings, activityId).id, "123-history");
            assert.equal(runs.activityStatus(saved), "已執行");
            if (history.minutes === undefined || history.minutes < 10) {
                assert.throws(() => runs.start(randomUUID(), settings, activityId), /10～1440/);
            }

            // 期限差異不允許重播同一請求，更不能重新啟動 worker。
            const changes =
                history.minutes === undefined
                    ? [{ ...activity, maxRunMinutes: 10 }]
                    : [activity, { ...activity, maxRunMinutes: 11 }];
            for (const changed of changes) {
                assert.throws(() => runs.start(requestId, changed, activityId), /更換設定/);
                assert.equal(runs.activityStatus({ ...saved, settings: changed }), "設定已更新");
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

test("API 期限保存重讀與移除；無效更新不改檔，啟動前比對期限差異", async () => {
    // 建立獨立活動儲存與服務，不碰真實購票頁。
    const dir = await mkdtemp(join(tmpdir(), "tp-deadline-api-"));
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
        const settings = { ...activity, maxRunMinutes: 10 };
        const created = await request("/api/activities", "POST", settings);
        assert.equal(created.status, 201);
        const saved = await created.json();
        assert.deepEqual((await store.load(saved.id)).settings, settings);
        assert.deepEqual((await (await request("/api/activities/" + saved.id)).json()).settings, settings);

        // 錯誤輸入不能覆寫原檔，畫面持有舊期限不能啟動。
        const file = join(dir, "events", saved.id + ".json");
        const bytes = await readFile(file, "utf8");
        const invalid = await request("/api/activities/" + saved.id, "PUT", { ...activity, maxRunMinutes: 0 });
        assert.equal(invalid.status, 400);
        assert.equal(await readFile(file, "utf8"), bytes);
        for (const expectedActivity of [activity, { ...activity, maxRunMinutes: 11 }]) {
            const response = await request("/api/purchase", "POST", {
                requestId: randomUUID(),
                activityId: saved.id,
                expectedActivity,
            });
            assert.equal(response.status, 400);
            const rejected = await response.json();
            assert.match(rejected.error, /已變更/);
            assert.equal(rejected.notAccepted, true);
        }

        // 移除選填期限會實際移除欄位，不保留上一份設定或補入預設值。
        assert.equal((await request("/api/activities/" + saved.id, "PUT", activity)).status, 200);
        assert.deepEqual((await store.load(saved.id)).settings, activity);
        assert.equal("maxRunMinutes" in JSON.parse(await readFile(file, "utf8")).settings, false);
        assert(!purchaseOccupied(runtime));
        assert.deepEqual(await readdir(join(runtime, "runs")), []);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("新購票期限必填且至少 10 分鐘；舊設定讀取不補值", async t => {
    const launch = t.mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("must not launch");
    });
    for (const maxRunMinutes of [undefined, 1, 9]) {
        const settings = maxRunMinutes === undefined ? activity : { ...activity, maxRunMinutes };
        assert.deepEqual(parseTicketPlusActivity(settings), settings);
        assert.throws(() => validateTicketPlusRunSettings(settings), /10～1440/);
        await assert.rejects(
            runTicketPlus(settings, {
                lease: { path: "/missing-duration.lock", token: "invalid" } as never,
            }),
            /10～1440/,
        );
    }
    for (const maxRunMinutes of [10, 1440]) {
        assert.doesNotThrow(() => validateTicketPlusRunSettings({ ...activity, maxRunMinutes }));
    }
    assert.equal(launch.mock.callCount(), 0);
});

test("舊活動缺值及 1／9 分鐘可重讀但新 API 啟動拒絕，不改檔或取得占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tp-duration-legacy-"));
    const runtime = join(dir, "runtime");
    const store = new ActivityStore(join(dir, "events"));
    const service = await startLocalServer(store, {
        runDirectory: runtime,

        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const request = (path: string, body?: unknown) =>
            fetch(service.url + path, {
                method: body === undefined ? "GET" : "POST",
                headers: { "X-Local-Token": token, "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        for (const maxRunMinutes of [undefined, 1, 9]) {
            const settings = maxRunMinutes === undefined ? activity : { ...activity, maxRunMinutes };
            const saved = await (await request("/api/activities", settings)).json();
            const file = join(dir, "events", saved.id + ".json");
            const before = await readFile(file, "utf8");
            const loaded = await (await request("/api/activities/" + saved.id)).json();
            assert.deepEqual(loaded.settings, settings);
            assert.equal(loaded.updatedAt, saved.updatedAt);
            const rejected = await request("/api/purchase", {
                requestId: randomUUID(),
                activityId: saved.id,
                expectedActivity: settings,
            });
            assert.equal(rejected.status, 400);
            const error = await rejected.json();
            assert.equal(error.notAccepted, true);
            assert.match(error.error, /10～1440/);
            assert.equal(await readFile(file, "utf8"), before);
        }
        assert(!purchaseOccupied(runtime));
        assert.deepEqual(await readdir(join(runtime, "runs")), []);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
