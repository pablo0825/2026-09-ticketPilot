import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityStore } from "../src/config/activityStore.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { SimulationRuns } from "../src/local/simulationRuns.js";
import { startLocalServer } from "../src/local/server.js";
import { activityForm } from "../src/local/react/platforms/klook/formModel.js";
import { parseTicketPlusActivity } from "../src/config/ticketPlusActivity.js";

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
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "fixture@example.com",
};

test("混合平台設定可存取；無效更新與跨平台覆寫保留原檔", async () => {
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
        await store.save(klook);
        const list = await store.list();
        assert.deepEqual(list.activities.map(a => a.settings.platform).sort(), ["klook", "ticketplus"]);
        assert.equal(list.invalidFiles, 0);
        assert.throws(() => activityForm(parseTicketPlusActivity(ticketplus)), /僅支援 Klook/);

        // 失敗更新不得修改檔案，合法更新保留活動識別碼
        await assert.rejects(
            store.save({ ...ticketplus, targets: [{ ...ticketplus.targets[0]!, quantity: 0 }] }, saved.id),
        );
        await assert.rejects(store.save(klook, saved.id), /不能變更/);
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

test("TicketPlus 拒絕誤傳聯絡資料，模擬仍拒絕，不建立占用或請求紀錄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-start-"));
    const purchases = new PurchaseRuns(dir, new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url));
    const simulation = new SimulationRuns();
    try {
        // 購票拒絕不適用的聯絡資料；模擬仍不支援 TicketPlus
        for (const details of [contact, null, {}]) {
            const id = randomUUID();
            assert.throws(() => purchases.start(id, ticketplus, details), /不接受聯絡資料/);
            assert.throws(() => simulation.start(id, ticketplus, details), /TicketPlus.*尚未實作/);
            assert.equal(purchases.hasRequest(id), false);
            assert.equal(simulation.hasRequest(id), false);
        }

        // 拒絕不能留下執行副作用
        assert.equal(purchaseOccupied(dir), false);
        assert.equal(purchases.busy(), false);
        assert.equal(purchases.snapshot(), null);
        assert.equal(simulation.snapshot(), null);
        assert.deepEqual(await readdir(join(dir, "runs")), []);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        purchases.close();
        simulation.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("HTTP 可儲存 TicketPlus；模擬仍拒絕，購票拒絕誤傳聯絡資料", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-api-"));
    const runtime = join(dir, "runtime");
    const contactPath = join(dir, "contact.json");
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        contactPath,
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
            for (const endpoint of ["purchase", "simulation"]) {
                const input =
                    endpoint === "purchase"
                        ? {
                              requestId: randomUUID(),
                              activityId: created.id,
                              expectedActivity: ticketplus,
                              expectedContact: null,
                          }
                        : { requestId: randomUUID(), activityId: created.id };
                const response = await fetch(service.url + "/api/" + endpoint, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(input),
                });
                assert.equal(response.status, 400);
                const error = await response.json();
                assert.match(error.error, endpoint === "purchase" ? /不接受聯絡資料/ : /TicketPlus.*尚未實作/);
                assert.equal(error.notAccepted, true);
            }
        }

        // API 拒絕後也不留程序或購票紀錄
        assert.equal(await (await fetch(service.url + "/api/purchase", { headers })).json(), null);
        assert.equal(await (await fetch(service.url + "/api/run", { headers })).json(), null);
        assert.equal(purchaseOccupied(runtime), false);
        assert.deepEqual(await readdir(join(runtime, "runs")), []);
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
