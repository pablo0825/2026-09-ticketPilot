import { test } from "node:test";
import assert from "node:assert/strict";
import { request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiActivity } from "../../fixtures/ticketplus/apiHarness.js";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { startLocalServer } from "../../../src/server/server.js";

interface RawResponse {
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
}

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
}

// fetch 不能自訂 Host，也不能保留未送完的內容，所以改用 node:http。
function openRequest(
    serviceUrl: string,
    path: string,
    options: RequestOptions = {},
): { outgoing: ClientRequest; response: Promise<RawResponse> } {
    let outgoing!: ClientRequest;
    const response = new Promise<RawResponse>((resolve, reject) => {
        outgoing = request(
            new URL(path, serviceUrl),
            { method: options.method ?? "GET", headers: options.headers },
            incoming => {
                const chunks: Buffer[] = [];
                incoming.on("data", chunk => chunks.push(chunk));
                incoming.on("end", () =>
                    resolve({
                        status: incoming.statusCode ?? 0,
                        headers: incoming.headers,
                        body: Buffer.concat(chunks).toString("utf8"),
                    }),
                );
            },
        );
        outgoing.on("error", reject);
    });
    return { outgoing, response };
}

function rawRequest(serviceUrl: string, path: string, options: RequestOptions & { body?: string } = {}) {
    // DELETE 等方法不會自動加上長度；沒有長度時內容會被當成下一個請求。
    const headers =
        options.body === undefined
            ? options.headers
            : { ...options.headers, "Content-Length": String(Buffer.byteLength(options.body)) };
    const { outgoing, response } = openRequest(serviceUrl, path, { ...options, headers });
    outgoing.end(options.body);
    return response;
}

async function startService(createStore = (dir: string) => new ActivityStore(join(dir, "events"))) {
    const dir = await mkdtemp(join(tmpdir(), "ticket-pipeline-"));
    const service = await startLocalServer(createStore(dir), { runDirectory: join(dir, "runtime") });

    // close() 第二次呼叫會失敗；測試內已關閉時，清理不再重複關閉。
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await service.close();
    };
    const cleanup = async () => {
        try {
            await close();
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    };

    try {
        const html = await (await fetch(service.url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)?.[1];
        assert(token);
        return { dir, url: service.url, token, close, cleanup };
    } catch (error) {
        await cleanup();
        throw error;
    }
}

test("本機服務：首頁只回應本機 Host、同源與非跨站請求，並帶安全標頭", async () => {
    const { url, token, cleanup } = await startService();
    try {
        const page = await rawRequest(url, "/");
        assert.equal(page.status, 200);
        assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(
            page.headers["content-security-policy"],
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        );
        assert.equal(page.headers["referrer-policy"], "no-referrer");
        assert.equal(page.headers["cache-control"], "no-store");

        // DNS rebinding 時只有 Host 不同；必須在提供含 token 的網頁前拒絕。
        const port = new URL(url).port;
        const rejectedHeaders: Record<string, string>[] = [
            { Host: `evil.example:${port}` },
            { Host: `localhost:${port}` },
            { Origin: "https://evil.example" },
        ];
        for (const headers of rejectedHeaders) {
            const rejected = await rawRequest(url, "/", { headers });
            assert.equal(rejected.status, 403);
            assert(!rejected.body.includes(token));
        }

        const crossSite = await rawRequest(url, "/", { headers: { "Sec-Fetch-Site": "cross-site" } });
        assert.equal(crossSite.status, 403);
        assert.equal(crossSite.body, "{}");
    } finally {
        await cleanup();
    }
});

test("本機服務：靜態檔缺少時回固定訊息，不符合檔名規則的路徑需 token", async () => {
    const { url, token, cleanup } = await startService();
    try {
        const missing = await rawRequest(url, "/assets/missing-file.js");
        assert.equal(missing.status, 400);
        assert.deepEqual(JSON.parse(missing.body), { error: "本機資料處理失敗。" });

        assert.equal((await rawRequest(url, "/assets/nested/file.js")).status, 403);
        const withToken = await rawRequest(url, "/assets/nested/file.js", { headers: { "X-Local-Token": token } });
        assert.equal(withToken.status, 404);
    } finally {
        await cleanup();
    }
});

test("本機服務：只有事件串流接受網址 token，header 錯誤時不改用網址 token", async () => {
    const { url, token, cleanup } = await startService();
    try {
        assert.equal((await rawRequest(url, `/api/purchase?token=${token}`)).status, 403);
        assert.equal((await rawRequest(url, `/api/activities?token=${token}`)).status, 403);
        assert.equal((await rawRequest(url, `/api/purchase/events?token=${"0".repeat(64)}`)).status, 403);
        const wrongHeader = await rawRequest(url, `/api/purchase/events?token=${token}`, {
            headers: { "X-Local-Token": "0".repeat(64) },
        });
        assert.equal(wrongHeader.status, 403);

        const stream = await fetch(`${url}/api/purchase/events?token=${token}`);
        assert.equal(stream.status, 200);
        assert.equal(stream.headers.get("content-type"), "text/event-stream");
        await stream.body?.cancel();
    } finally {
        await cleanup();
    }
});

test("本機服務：事件串流仍開著時，關閉服務會結束串流", { timeout: 10_000 }, async () => {
    const { url, token, close, cleanup } = await startService();
    const stream = await fetch(`${url}/api/purchase/events?token=${token}`);
    const reader = stream.body!.getReader();
    try {
        const first = await reader.read();
        assert.match(new TextDecoder().decode(first.value), /^data: /);

        // 服務沒有主動結束串流時，close() 會一直等待，由測試逾時判定失敗。
        await close();
        assert.equal((await reader.read()).done, true);
    } finally {
        await reader.cancel().catch(() => {});
        await cleanup();
    }
});

test("本機服務：修改請求依序處理，讀取請求不等待", async () => {
    const { url, token, cleanup } = await startService();
    const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
    let held: ReturnType<typeof openRequest> | undefined;
    let deletion: Promise<RawResponse> | undefined;
    try {
        const createdResponse = await rawRequest(url, "/api/activities", {
            method: "POST",
            headers,
            body: JSON.stringify(apiActivity),
        });
        assert.equal(createdResponse.status, 201);
        const created = JSON.parse(createdResponse.body);

        // 送出內容未完成的新增請求，讓它持有修改順序。
        const body = JSON.stringify(apiActivity);
        held = openRequest(url, "/api/activities", {
            method: "POST",
            headers: { ...headers, "Transfer-Encoding": "chunked" },
        });
        held.outgoing.write(body.slice(0, 10));
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.equal((await rawRequest(url, "/api/purchase", { headers })).status, 200);
        assert.equal((await rawRequest(url, "/api/activities", { headers })).status, 200);

        let deleted = false;
        deletion = rawRequest(url, "/api/activities/" + created.id, { method: "DELETE", headers }).then(response => {
            deleted = true;
            return response;
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(deleted, false);

        held.outgoing.end(body.slice(10));
        assert.equal((await held.response).status, 201);
        assert.equal((await deletion).status, 200);
    } finally {
        // 斷言失敗時中斷未送完的請求，否則它持有順序，服務無法關閉。
        if (held) {
            held.response.catch(() => {});
            held.outgoing.destroy();
        }
        await deletion?.catch(() => {});
        await cleanup();
    }
});

test("本機服務：檔案系統錯誤只回固定訊息，不輸出路徑", async () => {
    const { dir, url, token, cleanup } = await startService(dir => new ActivityStore(join(dir, "events-file")));
    try {
        await writeFile(join(dir, "events-file"), "");
        const response = await rawRequest(url, "/api/activities", { headers: { "X-Local-Token": token } });
        assert.equal(response.status, 400);
        assert.deepEqual(JSON.parse(response.body), { error: "本機資料處理失敗。" });
        assert(!response.body.includes(dir));
    } finally {
        await cleanup();
    }
});

test("本機服務：各執行 API 的格式錯誤保留各自訊息，購票格式錯誤不回傳 notAccepted", async () => {
    const { url, token, cleanup } = await startService();
    try {
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        for (const [path, input, message] of [
            ["/api/purchase", {}, "購票請求格式錯誤。"],
            ["/api/purchase", { requestId: "request", activityId: "activity", extra: true }, "購票請求格式錯誤。"],
            ["/api/purchase", { requestId: 42, activityId: "activity" }, "購票請求格式錯誤。"],
            ["/api/purchase", { requestId: "request", activityId: null }, "購票請求格式錯誤。"],
            ["/api/purchase/stop", {}, "停止請求格式錯誤。"],
            ["/api/purchase/stop", { runId: 42 }, "停止請求格式錯誤。"],
            ["/api/purchase/stop", { runId: " " }, "停止請求格式錯誤。"],
            ["/api/purchase/confirm-login", { runId: "run" }, "登入確認請求格式錯誤。"],
            ["/api/purchase/confirm-login", { runId: 42, confirmationId: "confirm" }, "登入確認請求格式錯誤。"],
            ["/api/purchase/confirm-login", { runId: " ", confirmationId: "confirm" }, "登入確認請求格式錯誤。"],
            ["/api/purchase/confirm-login", { runId: "run", confirmationId: null }, "登入確認請求格式錯誤。"],
            ["/api/purchase/confirm-participants", { runId: "run" }, "參加者確認請求格式錯誤。"],
            [
                "/api/purchase/confirm-participants",
                { runId: 42, confirmationId: "confirm" },
                "參加者確認請求格式錯誤。",
            ],
            [
                "/api/purchase/confirm-participants",
                { runId: " ", confirmationId: "confirm" },
                "參加者確認請求格式錯誤。",
            ],
            ["/api/purchase/confirm-participants", { runId: "run", confirmationId: null }, "參加者確認請求格式錯誤。"],
            ["/api/purchase/close-browser", { runId: "run", extra: true }, "關閉請求格式錯誤。"],
            ["/api/purchase/close-browser", { runId: 42 }, "關閉請求格式錯誤。"],
        ] as const) {
            const response = await rawRequest(url, path, { method: "POST", headers, body: JSON.stringify(input) });
            assert.equal(response.status, 400, path);
            assert.deepEqual(JSON.parse(response.body), { error: message }, path);
        }
    } finally {
        await cleanup();
    }
});

test("本機服務：活動 API 只比對完整路徑，其他方法與路徑回 404", async () => {
    const { url, token, cleanup } = await startService();
    try {
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        for (const [method, path] of [
            ["POST", "/api/activities/some-id"],
            ["PUT", "/api/activities"],
            ["DELETE", "/api/activities"],
            ["GET", "/api/activities/some-id/extra"],
            ["GET", "/api/activitiesx"],
        ] as const) {
            const response = await rawRequest(url, path, { method, headers, body: "{}" });
            assert.equal(response.status, 404, `${method} ${path}`);
        }
    } finally {
        await cleanup();
    }
});
