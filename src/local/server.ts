import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ActivityStore } from "../config/activityStore.js";
import { SimulationRuns } from "./simulationRuns.js";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("設定內容過大。");
        chunks.push(chunk);
    }
    try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        return value as Record<string, unknown>;
    } catch { throw new Error("請提供有效的 JSON 物件。"); }
}

export async function startLocalServer(store = new ActivityStore()) {
    const token = randomBytes(32).toString("hex");
    const runs = new SimulationRuns();
    const streams = new Set<ServerResponse>();
    let origin = "";
    function json(response: ServerResponse, status: number, value: unknown) {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(value));
    }
    const server = createServer(async (request, response) => {
        try {
            if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) {
                json(response, 403, { error: "僅接受本機介面請求。" }); return;
            }
            const url = new URL(request.url ?? "/", origin);
            if (request.method === "GET" && url.pathname === "/") {
                if (request.headers["sec-fetch-site"] === "cross-site") { json(response, 403, {}); return; }
                const html = (await readFile(new URL("./index.html", import.meta.url), "utf8")).replace("__TOKEN__", token);
                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
                    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
                    "Referrer-Policy": "no-referrer",
                });
                response.end(html); return;
            }
            // EventSource 不能設定自訂 header，訂閱 token 只用於本機短期連線。
            const supplied = request.headers["x-local-token"] ?? (url.pathname === "/api/events" ? url.searchParams.get("token") : undefined);
            if (supplied !== token) { json(response, 403, { error: "本機工作階段無效。" }); return; }
            if (request.method === "GET" && url.pathname === "/api/events") {
                response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
                streams.add(response);
                const send = () => response.write(`data: ${JSON.stringify(runs.snapshot())}\n\n`);
                send();
                const unsubscribe = runs.subscribe(send);
                const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
                response.on("close", () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/activities") { json(response, 200, await store.list()); return; }
            const match = /^\/api\/activities\/([^/]+)$/.exec(url.pathname);
            if (request.method === "GET" && match) { json(response, 200, await store.load(match[1]!)); return; }
            if (request.method === "POST" && url.pathname === "/api/activities") { json(response, 201, await store.save(await body(request))); return; }
            if (request.method === "PUT" && match) { json(response, 200, await store.save(await body(request), match[1]!)); return; }
            if (request.method === "GET" && url.pathname === "/api/run") { json(response, 200, runs.snapshot()); return; }
            if (request.method === "POST" && url.pathname === "/api/simulation") {
                const input = await body(request);
                if (Object.keys(input).some(key => !["requestId", "activityId", "contact"].includes(key)) ||
                    typeof input.requestId !== "string" || typeof input.activityId !== "string") throw new Error("模擬請求格式錯誤。");
                const activity = await store.load(input.activityId);
                json(response, 200, runs.start(input.requestId, activity.settings, input.contact)); return;
            }
            json(response, 404, { error: "此階段未提供此功能；網頁僅支援模擬執行。" });
        } catch (error) {
            // 設定/模擬只回傳固定驗證訊息；檔案系統細節不輸出。
            const message = error instanceof Error && !("code" in error) ? error.message : "本機資料處理失敗。";
            if (!response.headersSent) json(response, 400, { error: message });
            else response.end();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("無法啟動本機服務。");
    origin = `http://127.0.0.1:${address.port}`;
    return {
        url: origin,
        async close() {
            for (const stream of streams) stream.end();
            await runs.close();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        },
    };
}
