import { PurchaseRuns } from "./purchaseRuns.js";
import { loadContactDetails, saveContactDetails, validateContactDetails } from "../config/contact.config.js";
import { parseActivity, projectRoot } from "../config/activityStore.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
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
    } catch {
        throw new Error("請提供有效的 JSON 物件。");
    }
}

export async function startLocalServer(
    store = new ActivityStore(),
    options: {
        contactPath?: string;
        runDirectory?: string;
        purchaseWorker?: URL;
    } = {},
) {
    const contactPath = options.contactPath ?? join(projectRoot, "contact.local.json");
    const purchases = new PurchaseRuns(options.runDirectory, options.purchaseWorker);
    const token = randomBytes(32).toString("hex");
    const runs = new SimulationRuns();
    const streams = new Set<ServerResponse>();
    let origin = "";
    let mutationTail = Promise.resolve();
    function json(response: ServerResponse, status: number, value: unknown) {
        response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify(value));
    }
    const server = createServer(async (request, response) => {
        let releaseMutation: (() => void) | undefined;
        let notAccepted: (() => boolean) | undefined;
        try {
            if (
                request.headers.host !== new URL(origin).host ||
                (request.headers.origin && request.headers.origin !== origin)
            ) {
                json(response, 403, { error: "僅接受本機介面請求。" });
                return;
            }
            const url = new URL(request.url ?? "/", origin);
            if (request.method === "GET" && url.pathname === "/") {
                if (request.headers["sec-fetch-site"] === "cross-site") {
                    json(response, 403, {});
                    return;
                }
                const html = (await readFile(new URL("./index.html", import.meta.url), "utf8")).replace(
                    "__TOKEN__",
                    token,
                );
                response.writeHead(200, {
                    "Content-Type": "text/html; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Security-Policy":
                        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
                    "Referrer-Policy": "no-referrer",
                });
                response.end(html);
                return;
            }
            if (request.method === "GET" && ["/app.js", "/style.css"].includes(url.pathname)) {
                response.writeHead(200, {
                    "Content-Type": url.pathname.endsWith(".js")
                        ? "text/javascript; charset=utf-8"
                        : "text/css; charset=utf-8",
                    "Cache-Control": "no-store",
                });
                response.end(await readFile(new URL(`.${url.pathname}`, import.meta.url), "utf8"));
                return;
            }
            // EventSource 不能設定自訂 header，訂閱 token 只用於本機短期連線。
            const supplied =
                request.headers["x-local-token"] ??
                (["/api/events", "/api/purchase/events"].includes(url.pathname)
                    ? url.searchParams.get("token")
                    : undefined);
            if (supplied !== token) {
                json(response, 403, { error: "本機工作階段無效。" });
                return;
            }
            // 活動儲存、刪除和啟動共用順序，避免 await 期間互相穿插。
            if (["POST", "PUT", "DELETE"].includes(request.method ?? "")) {
                const previous = mutationTail;
                mutationTail = new Promise<void>(resolve => {
                    releaseMutation = resolve;
                });
                await previous;
            }
            if (request.method === "GET" && ["/api/events", "/api/purchase/events"].includes(url.pathname)) {
                const manager = url.pathname === "/api/events" ? runs : purchases;
                response.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-store",
                    Connection: "keep-alive",
                });
                streams.add(response);
                const send = () => response.write(`data: ${JSON.stringify(manager.snapshot())}\n\n`);
                send();
                const unsubscribe = manager.subscribe(send);
                const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
                response.on("close", () => {
                    clearInterval(heartbeat);
                    unsubscribe();
                    streams.delete(response);
                });
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/contact") {
                json(response, 200, {
                    contact: existsSync(contactPath) ? await loadContactDetails(contactPath) : null,
                });
                return;
            }
            if (request.method === "PUT" && url.pathname === "/api/contact") {
                await saveContactDetails(await body(request), contactPath);
                json(response, 200, { saved: true });
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/purchase") {
                json(response, 200, purchases.snapshot());
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/purchase/close-browser") {
                const input = await body(request);
                if (Object.keys(input).some(key => key !== "runId") || typeof input.runId !== "string")
                    throw new Error("關閉請求格式錯誤。");
                json(response, 200, await purchases.closeBrowser(input.runId));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/purchase") {
                const input = await body(request);
                if (
                    Object.keys(input).some(
                        key => !["requestId", "activityId", "expectedActivity", "expectedContact"].includes(key),
                    ) ||
                    typeof input.requestId !== "string" ||
                    typeof input.activityId !== "string"
                )
                    throw new Error("購票請求格式錯誤。");
                const requestId = input.requestId;
                notAccepted = () => !purchases.hasRequest(requestId);
                const expectedActivity = parseActivity(input.expectedActivity);
                const expectedContact = validateContactDetails(input.expectedContact);
                const activity = await store.load(input.activityId);
                const contact = await loadContactDetails(contactPath);
                if (
                    JSON.stringify(activity.settings) !== JSON.stringify(expectedActivity) ||
                    JSON.stringify(contact) !== JSON.stringify(expectedContact)
                ) {
                    throw new Error("活動或聯絡資料已變更，請重新載入、儲存並確認摘要。");
                }
                if (runs.snapshot()?.status === "running") throw new Error("請先等待模擬結束。");
                json(response, 200, purchases.start(input.requestId, activity.settings, contact, activity.id));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/activities") {
                const result = await store.list();
                json(response, 200, {
                    ...result,
                    activities: result.activities.map(activity => ({
                        ...activity,
                        executionStatus: purchases.activityStatus(activity),
                    })),
                });
                return;
            }
            const match = /^\/api\/activities\/([^/]+)$/.exec(url.pathname);
            if (request.method === "DELETE" && match) {
                if (purchases.busy() || runs.snapshot()?.status === "running")
                    throw new Error("執行或瀏覽器占用中，不能刪除活動。");
                await store.remove(match[1]!);
                json(response, 200, { deleted: true });
                return;
            }
            if (request.method === "GET" && match) {
                json(response, 200, await store.load(match[1]!));
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/activities") {
                json(response, 201, await store.save(await body(request)));
                return;
            }
            if (request.method === "PUT" && match) {
                const input = await body(request);
                const revision = request.headers["x-activity-revision"];
                if (revision !== undefined && revision !== (await store.load(match[1]!)).updatedAt) {
                    throw new Error("活動設定已被其他分頁修改，請重新載入並確認。");
                }
                json(response, 200, await store.save(input, match[1]!));
                return;
            }
            if (request.method === "GET" && url.pathname === "/api/run") {
                json(response, 200, runs.snapshot());
                return;
            }
            if (request.method === "POST" && url.pathname === "/api/simulation") {
                const input = await body(request);
                if (
                    Object.keys(input).some(key => !["requestId", "activityId", "contact"].includes(key)) ||
                    typeof input.requestId !== "string" ||
                    typeof input.activityId !== "string"
                )
                    throw new Error("模擬請求格式錯誤。");
                const requestId = input.requestId;
                notAccepted = () => !runs.hasRequest(requestId);
                const activity = await store.load(input.activityId);
                if (purchases.busy()) throw new Error("購票流程仍占用瀏覽器。");
                json(response, 200, runs.start(input.requestId, activity.settings, input.contact));
                return;
            }
            json(response, 404, { error: "找不到此功能。" });
        } catch (error) {
            // 設定/模擬只回傳固定驗證訊息；檔案系統細節不輸出。
            const message = error instanceof Error && !("code" in error) ? error.message : "本機資料處理失敗。";
            if (!response.headersSent) json(response, 400, { error: message, notAccepted: notAccepted?.() });
            else response.end();
        } finally {
            releaseMutation?.();
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("無法啟動本機服務。");
    origin = `http://127.0.0.1:${address.port}`;
    return {
        url: origin,
        async close() {
            purchases.close();
            for (const stream of streams) stream.end();
            await runs.close();
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        },
    };
}
