import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

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

test("本機 API：驗證、保存、去重、快照及模擬結束；無實站入口", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-server-"));
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        contactPath: join(dir, "contact.json"),
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
            await fetch(service.url + "/api/activities", { method: "POST", headers, body: JSON.stringify(activity) })
        ).json();
        const input = { requestId: randomUUID(), activityId: created.id, contact };
        const start = () =>
            fetch(service.url + "/api/simulation", { method: "POST", headers, body: JSON.stringify(input) });
        assert.equal(
            (
                await fetch(service.url + "/api/simulation", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...input, contact: {} }),
                })
            ).status,
            400,
        );
        assert.equal(await (await fetch(service.url + "/api/run", { headers })).json(), null);
        const run = await (await start()).json();
        assert.equal(run.status, "running");
        assert.equal((await (await start()).json()).id, run.id);
        assert.equal(
            (
                await fetch(service.url + "/api/simulation", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...input, requestId: randomUUID() }),
                })
            ).status,
            400,
        );
        await fetch(service.url + `/api/activities/${created.id}`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ ...activity, targets: [{ ...activity.targets[0], area: "C區" }] }),
        });
        let current = run;
        for (let n = 0; n < 100 && current.status === "running"; n++) {
            await new Promise(resolve => setTimeout(resolve, 50));
            current = await (await fetch(service.url + "/api/run", { headers })).json();
        }
        assert.equal(current.status, "completed");
        assert.match(JSON.stringify(current), /B區/);
        assert.doesNotMatch(JSON.stringify(current), /PrivateName|private@example.com|0912345678|C區/);
        assert.equal((await fetch(service.url + "/api/live", { method: "POST", headers })).status, 404);
        assert.equal(
            (
                await fetch(service.url + "/api/simulation", {
                    method: "POST",
                    headers,
                    body: JSON.stringify({ ...input, mode: "live" }),
                })
            ).status,
            400,
        );
        const stream = await fetch(service.url + `/api/events?token=${token}`);
        const reader = stream.body!.getReader();
        const first = new TextDecoder().decode((await reader.read()).value);
        assert.match(first, new RegExp(run.id));
        await reader.cancel();
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("Klook 開始購票：缺少或無效聯絡資料時拒絕，不啟動子程序也不留下占用", async () => {
    // 真實服務與獨立資料夾；子程序只記錄啟動次數，不讀取專案的 local-data。
    const dir = await mkdtemp(join(tmpdir(), "ticket-contact-"));
    const contactPath = join(dir, "contact.json");
    const runDirectory = join(dir, "runtime");
    const store = new ActivityStore(join(dir, "events"));
    const created = await store.save(activity);
    const service = await startLocalServer(store, {
        contactPath,
        runDirectory,
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    try {
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };

        // 請求本身合法，錯誤只能來自讀取聯絡資料檔。
        const start = () =>
            fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    requestId: randomUUID(),
                    activityId: created.id,
                    expectedActivity: created.settings,
                    expectedContact: contact,
                }),
            });

        // 缺檔、JSON 無效、缺欄位、格式錯誤與讀取失敗都必須拒絕
        const cases: [string | null, RegExp][] = [
            [null, /缺少 contact.local.json.*contact.example.json/],
            ["{bad", /不是有效的 JSON/],
            [JSON.stringify({ ...contact, firstName: undefined }), /請填寫名字/],
            [JSON.stringify({ ...contact, email: "invalid" }), /電子信箱格式不完整/],
        ];
        if (process.getuid?.() !== 0) cases.push([JSON.stringify(contact), /無法讀取 contact.local.json/]);
        for (const [index, [source, message]] of cases.entries()) {
            await rm(contactPath, { force: true });
            if (source !== null) await writeFile(contactPath, source);
            if (message.source.includes("無法讀取")) await chmod(contactPath, 0o000);

            const response = await start();
            const text = await response.text();
            assert.equal(response.status, 400, `情境 ${index}`);
            assert.match(JSON.parse(text).error, message);
            assert.doesNotMatch(text, /PrivateName|private@example\.com|0912345678/);
            assert.ok(!text.includes(contactPath));
            await chmod(contactPath, 0o600).catch(() => {});
        }

        // 被拒絕的請求不能啟動子程序或留下占用
        await assert.rejects(readFile(join(runDirectory, "worker-starts.txt")), { code: "ENOENT" });
        await assert.rejects(readFile(join(runDirectory, "purchase.lock")), { code: "ENOENT" });

        // 補齊聯絡資料後才會啟動，且只啟動一次
        await writeFile(contactPath, JSON.stringify(contact));
        assert.equal((await start()).status, 200);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            const run = await (await fetch(service.url + "/api/purchase", { headers })).json();
            if (!run.occupied && run.status !== "running") break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(await readFile(join(runDirectory, "worker-starts.txt"), "utf8"), "started\n");
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
