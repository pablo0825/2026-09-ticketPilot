import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

const activity = { eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/", eventName: "測試活動", fallbackMode: "STRICT", excludeKeywords: [], targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false }] };
const contact = { firstName: "PrivateName", lastName: "Test", regionLabel: "台灣 (+886)", phone: "0912345678", email: "private@example.com" };

test("本機 API：驗證、保存、去重、快照及模擬結束；無實站入口", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-server-"));
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), { contactPath: join(dir, "contact.json"), runDirectory: join(dir, "runtime") });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /const token = "([a-f0-9]+)"/.exec(html)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        assert.equal((await fetch(service.url + "/api/activities")).status, 403);
        assert.equal((await fetch(service.url + "/api/activities", { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
        const created = await (await fetch(service.url + "/api/activities", { method: "POST", headers, body: JSON.stringify(activity) })).json();
        const input = { requestId: randomUUID(), activityId: created.id, contact };
        const start = () => fetch(service.url + "/api/simulation", { method: "POST", headers, body: JSON.stringify(input) });
        assert.equal((await fetch(service.url + "/api/simulation", { method: "POST", headers, body: JSON.stringify({ ...input, contact: {} }) })).status, 400);
        assert.equal(await (await fetch(service.url + "/api/run", { headers })).json(), null);
        const run = await (await start()).json();
        assert.equal(run.status, "running");
        assert.equal((await (await start()).json()).id, run.id);
        assert.equal((await fetch(service.url + "/api/simulation", { method: "POST", headers, body: JSON.stringify({ ...input, requestId: randomUUID() }) })).status, 400);
        await fetch(service.url + `/api/activities/${created.id}`, { method: "PUT", headers, body: JSON.stringify({ ...activity, targets: [{ ...activity.targets[0], area: "C區" }] }) });
        let current = run;
        for (let n = 0; n < 100 && current.status === "running"; n++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            current = await (await fetch(service.url + "/api/run", { headers })).json();
        }
        assert.equal(current.status, "completed");
        assert.match(JSON.stringify(current), /B區/);
        assert.doesNotMatch(JSON.stringify(current), /PrivateName|private@example.com|0912345678|C區/);
        assert.equal((await fetch(service.url + "/api/live", { method: "POST", headers })).status, 404);
        assert.equal((await fetch(service.url + "/api/simulation", { method: "POST", headers, body: JSON.stringify({ ...input, mode: "live" }) })).status, 400);
        const stream = await fetch(service.url + `/api/events?token=${token}`);
        const reader = stream.body!.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        assert.match(first, new RegExp(run.id));
        await reader.cancel();
    } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});
