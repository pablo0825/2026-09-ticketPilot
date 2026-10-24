import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityStore } from "../src/storage/activityStore.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";
import { startLocalServer } from "../src/local/server.js";

const ticketplus = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/0233a891800ffaa343bf8bff73d390e8",
    eventName: "TicketPlus 測試活動",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 }],
};
const canonical = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/0233a891800ffaa343bf8bff73d390e8",
    eventName: "TicketPlus 測試活動",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 }],
};
const klook = {
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "Klook 測試活動",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-10-30", time: "20:00", area: "A區", quantity: 1, adjacent: false }],
};

test("舊 Klook 與 TicketPlus 混存僅載入 TicketPlus；無效更新與跨平台覆寫保留原檔", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-store-"));
    const store = new ActivityStore(dir);
    try {
        // 檢查實際落盤內容，不用解析器產生預期答案
        const saved = await store.save(ticketplus);
        const path = join(dir, `${saved.id}.json`);
        const raw = await readFile(path, "utf8");
        assert.deepEqual(JSON.parse(raw).settings, canonical);
        assert.equal(JSON.parse(raw).schemaVersion, 3);
        assert.deepEqual((await store.load(saved.id)).settings, canonical);
        assert.equal(await readFile(path, "utf8"), raw);

        // 混合列表不漏資料，Klook 表單不能讀取 TicketPlus
        const oldId = randomUUID();
        await writeFile(
            join(dir, oldId + ".json"),
            JSON.stringify({ schemaVersion: 3, id: oldId, updatedAt: "2026-10-01T00:00:00.000Z", settings: klook }),
        );
        const list = await store.list();
        assert.deepEqual(list.activities.map(a => a.settings.platform).sort(), ["ticketplus"]);
        assert.equal(list.invalidFiles, 0);

        // 失敗更新不得修改檔案，合法更新保留活動識別碼
        await assert.rejects(
            store.save({ ...ticketplus, targets: [{ ...ticketplus.targets[0]!, quantity: 0 }] }, saved.id),
        );
        await assert.rejects(store.save(klook, saved.id), /Klook|TicketPlus/);
        assert.equal(await readFile(path, "utf8"), raw);
        const updated = await store.save(
            { ...ticketplus, targets: [{ ...ticketplus.targets[0]!, quantity: 2 }] },
            saved.id,
        );
        assert.equal(updated.id, saved.id);
        assert.deepEqual((await store.load(saved.id)).settings, {
            ...canonical,
            targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("HTTP 可儲存 TicketPlus；購票拒絕誤傳聯絡資料", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-api-"));
    const runtime = join(dir, "runtime");
    const contactPath = join(dir, "contact.json");
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        runDirectory: runtime,
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        // 透過真實本機 API 建立與讀取活動
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        const createdResponse = await fetch(service.url + "/api/activities", {
            method: "POST",
            headers,
            body: JSON.stringify(ticketplus),
        });
        assert.equal(createdResponse.status, 201);
        const created = await createdResponse.json();
        assert.deepEqual(created.settings, canonical);
        const loaded = await (await fetch(service.url + "/api/activities/" + created.id, { headers })).json();
        assert.deepEqual(loaded.settings, canonical);

        // 聯絡資料不存在或損壞都不得掩蓋平台拒絕訊息
        for (const corrupt of [false, true]) {
            if (corrupt) await writeFile(contactPath, "{broken");
            const input = {
                requestId: randomUUID(),
                activityId: created.id,
                expectedActivity: ticketplus,
                expectedContact: null,
            };
            const response = await fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify(input),
            });
            assert.equal(response.status, 400);
            const error = await response.json();
            assert.match(error.error, /不接受聯絡資料/);
            assert.equal(error.notAccepted, true);
        }

        // API 拒絕後也不留程序或購票紀錄
        assert.equal(await (await fetch(service.url + "/api/purchase", { headers })).json(), null);
        assert.equal(purchaseOccupied(runtime), false);
        assert.deepEqual(await readdir(join(runtime, "runs")), []);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
