import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { acquirePurchaseLease, releasePurchaseLease } from "../src/app/purchaseLock.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityStore } from "../src/storage/activityStore.js";
import { startLocalServer } from "../src/local/server.js";
const settings = apiActivity;

test("啟動與刪除並發只有一方成功，不刪執行紀錄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-home-start-"));
    const store = new ActivityStore(join(dir, "events"));
    const activity = await store.save(settings);
    const service = await startLocalServer(store, {
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url),
    });
    const html = await (await fetch(service.url)).text();
    const headers = {
        "X-Local-Token": html.match(/<meta name="local-token" content="([^"]+)"/)![1]!,
        "Content-Type": "application/json",
    };
    try {
        const [started, deleted] = await Promise.all([
            fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    requestId: crypto.randomUUID(),
                    activityId: activity.id,
                    expectedActivity: settings,
                }),
            }),
            fetch(`${service.url}/api/activities/${activity.id}`, { method: "DELETE", headers }),
        ]);
        assert.notEqual(started.status === 200, deleted.status === 200);
        if (started.status === 200) {
            for (let i = 0; i < 150; i++) {
                const run = await (await fetch(service.url + "/api/purchase", { headers })).json();
                if (!run.occupied) break;
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            const previous = await (await fetch(service.url + "/api/purchase", { headers })).json();
            assert.equal(
                (await fetch(`${service.url}/api/activities/${activity.id}`, { method: "DELETE", headers })).status,
                200,
            );
            assert.equal((await (await fetch(service.url + "/api/purchase", { headers })).json()).id, previous.id);
        }
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus 活動刪除受占用與權限保護，並發 PUT 不復活已刪資料", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticketplus-delete-"));
    const store = new ActivityStore(join(dir, "events"));
    const record = await store.save(apiActivity);
    const service = await startLocalServer(store, { runDirectory: join(dir, "runtime") });
    try {
        const html = await (await fetch(service.url)).text();
        const match = html.match(/<meta name="local-token" content="([^"]+)"/);
        assert(match?.[1]);
        const headers = { "X-Local-Token": match[1], "Content-Type": "application/json" };
        const url = `${service.url}/api/activities/${record.id}`;
        assert.equal((await fetch(url, { method: "DELETE" })).status, 403);
        assert.equal((await store.load(record.id)).id, record.id);
        const lease = acquirePurchaseLease(join(dir, "runtime"));
        try {
            assert.equal((await fetch(url, { method: "DELETE", headers })).status, 400);
            assert.equal((await store.load(record.id)).id, record.id);
        } finally {
            releasePurchaseLease(lease);
        }
        const [deleted] = await Promise.all([
            fetch(url, { method: "DELETE", headers }),
            fetch(url, { method: "PUT", headers, body: JSON.stringify(apiActivity) }),
        ]);
        assert.equal(deleted.status, 200);
        await assert.rejects(store.load(record.id));
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
