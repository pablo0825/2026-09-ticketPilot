import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { ActivityStore } from "../src/storage/activityStore.js";
import { startLocalServer } from "../src/server/server.js";

const activity = {
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "測試活動",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false }],
};
const contact = {
    firstName: "PrivateName",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "private@example.com",
};

test("本機 API：驗證、保存與移除的模擬入口不啟動程序", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-server-"));
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        runDirectory: join(dir, "runtime"),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        assert.equal((await fetch(service.url + "/api/activities")).status, 403);
        assert.equal(
            (await fetch(service.url + "/api/activities", { headers: { ...headers, Origin: "https://evil.example" } }))
                .status,
            403,
        );
        const created = await (
            await fetch(service.url + "/api/activities", { method: "POST", headers, body: JSON.stringify(apiActivity) })
        ).json();
        assert(created.id);
        for (const [method, path] of [
            ["POST", "/api/simulation"],
            ["GET", "/api/run"],
            ["GET", "/api/events"],
        ]) {
            const response = await fetch(service.url + path, { method, headers });
            assert.equal(response.status, 404);
        }
        assert.equal(await (await fetch(service.url + "/api/purchase", { headers })).json(), null);
        await assert.rejects(readFile(join(dir, "runtime", "purchase.lock")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("已移除的 Klook 與聯絡 API 拒絕請求，不建立 worker、紀錄或占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-retired-api-"));
    const store = new ActivityStore(join(dir, "events"));
    const created = await store.save(apiActivity);
    const oldId = randomUUID();
    const oldPath = join(dir, "events", oldId + ".json");
    const oldRaw = JSON.stringify({
        schemaVersion: 3,
        id: oldId,
        updatedAt: "2026-10-01T00:00:00.000Z",
        settings: activity,
    });
    await writeFile(oldPath, oldRaw);
    const runDirectory = join(dir, "runtime");
    const service = await startLocalServer(store, {
        runDirectory,
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)?.[1];
        assert(token);
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        for (const method of ["GET", "PUT"]) {
            const response = await fetch(service.url + "/api/contact", {
                method,
                headers,
                ...(method === "PUT" ? { body: JSON.stringify(contact) } : {}),
            });
            assert.equal(response.status, 404);
        }
        for (const [method, path] of [
            ["POST", "/api/activities"],
            ["PUT", "/api/activities/" + created.id],
            ["PUT", "/api/activities/" + oldId],
            ["GET", "/api/activities/" + oldId],
            ["DELETE", "/api/activities/" + oldId],
        ]) {
            const response = await fetch(service.url + path, {
                method,
                headers,
                ...(["POST", "PUT"].includes(method!) ? { body: JSON.stringify(activity) } : {}),
            });
            assert.equal(response.status, 400);
        }
        for (const body of [
            { activityId: oldId, expectedActivity: activity },
            { activityId: created.id, expectedActivity: apiActivity, expectedContact: contact },
        ]) {
            const response = await fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify({ requestId: randomUUID(), ...body }),
            });
            assert.equal(response.status, 400);
            assert.equal((await response.json()).notAccepted, true);
        }
        assert.equal(await readFile(oldPath, "utf8"), oldRaw);
        assert.deepEqual((await store.load(created.id)).settings, apiActivity);
        assert.deepEqual(await readdir(join(runDirectory, "runs")), []);
        await assert.rejects(readFile(join(runDirectory, "worker-starts.txt")), { code: "ENOENT" });
        await assert.rejects(readFile(join(runDirectory, "purchase.lock")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("重用 Klook 歷史請求 ID 回覆結果仍待確認，不清除 pending 或建立占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-archived-request-"));
    const store = new ActivityStore(join(dir, "events"));
    const created = await store.save(apiActivity);
    const runtime = join(dir, "runtime");
    const requestId = randomUUID();
    const runsDirectory = join(runtime, "runs");
    await mkdir(runsDirectory, { recursive: true });
    const historyPath = join(runsDirectory, requestId + ".json");
    const raw = JSON.stringify({
        fingerprintVersion: 4,
        fingerprint: "a".repeat(64),
        snapshot: {
            platform: "klook",
            id: "123-archived",
            requestId,
            activityName: "封存活動",
            status: "unknown",
            browserOpen: false,
            occupied: false,
            message: "提交結果不明",
            events: [],
            historyTruncated: false,
        },
    });
    await writeFile(historyPath, raw);
    const service = await startLocalServer(store, {
        runDirectory: runtime,
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)?.[1];
        assert(token);
        const response = await fetch(service.url + "/api/purchase", {
            method: "POST",
            headers: { "X-Local-Token": token, "Content-Type": "application/json" },
            body: JSON.stringify({ requestId, activityId: created.id, expectedActivity: apiActivity }),
        });
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.equal(result.notAccepted, false);
        assert.match(result.error, /Klook/);
        assert.equal(await readFile(historyPath, "utf8"), raw);
        assert.deepEqual(await readdir(runsDirectory), [requestId + ".json"]);
        await assert.rejects(readFile(join(runtime, "purchase.lock")), { code: "ENOENT" });
        await assert.rejects(readFile(join(runtime, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
