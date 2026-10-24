import { PurchaseRuns } from "./runs/purchaseRuns.js";
import { parseActivity } from "../config/activitySettings.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { ActivityStore } from "../storage/activityStore.js";
import { json } from "./http.js";
import { serveStatic } from "./staticAssets.js";

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    // 讀取請求內容，限制大小
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("設定內容過大。");
        chunks.push(chunk);
    }

    // 轉成 JSON 物件
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
        runDirectory?: string;
        purchaseWorker?: URL;
    } = {},
) {
    const purchases = new PurchaseRuns(options.runDirectory, options.purchaseWorker);
    const token = randomBytes(32).toString("hex");

    const streams = new Set<ServerResponse>();
    let origin = "";
    let mutationTail = Promise.resolve();

    const server = createServer(async (request, response) => {
        let releaseMutation: (() => void) | undefined;
        let notAccepted: (() => boolean) | undefined;

        try {
            // 只接受本機介面的請求
            if (
                request.headers.host !== new URL(origin).host ||
                (request.headers.origin && request.headers.origin !== origin)
            ) {
                json(response, 403, { error: "僅接受本機介面請求。" });
                return;
            }

            // 提供網頁與靜態檔案
            const url = new URL(request.url ?? "/", origin);
            if (await serveStatic(request, response, url, token)) return;

            // 以下的 API 都要先確認本機 token
            // EventSource 不能設定自訂 header，訂閱 token 只用於本機短期連線。
            const supplied =
                request.headers["x-local-token"] ??
                (url.pathname === "/api/purchase/events" ? url.searchParams.get("token") : undefined);
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

            // 以下依網址處理各個 API
            if (request.method === "GET" && url.pathname === "/api/purchase/events") {
                response.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-store",
                    Connection: "keep-alive",
                });

                streams.add(response);
                const send = () => response.write(`data: ${JSON.stringify(purchases.snapshot())}\n\n`);
                send();

                const unsubscribe = purchases.subscribe(send);
                const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
                response.on("close", () => {
                    clearInterval(heartbeat);
                    unsubscribe();
                    streams.delete(response);
                });
                return;
            }

            if (request.method === "GET" && url.pathname === "/api/purchase") {
                json(response, 200, purchases.snapshot());
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/purchase/stop") {
                const input = await body(request);
                if (Object.keys(input).length !== 1 || typeof input.runId !== "string" || !input.runId.trim()) {
                    throw new Error("停止請求格式錯誤。");
                }
                json(response, 200, await purchases.stop(input.runId));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/purchase/confirm-login") {
                const input = await body(request);
                if (
                    Object.keys(input).length !== 2 ||
                    typeof input.runId !== "string" ||
                    !input.runId.trim() ||
                    typeof input.confirmationId !== "string"
                ) {
                    throw new Error("登入確認請求格式錯誤。");
                }
                // 此回應不是新的購票啟動，不使用 notAccepted 授權另開一輪。
                json(response, 200, await purchases.confirmLogin(input.runId, input.confirmationId));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/purchase/confirm-participants") {
                const input = await body(request);
                if (
                    Object.keys(input).length !== 2 ||
                    typeof input.runId !== "string" ||
                    !input.runId.trim() ||
                    typeof input.confirmationId !== "string"
                ) {
                    throw new Error("參加者確認請求格式錯誤。");
                }
                json(response, 200, await purchases.confirmParticipants(input.runId, input.confirmationId));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/purchase/close-browser") {
                const input = await body(request);
                if (Object.keys(input).some(key => key !== "runId") || typeof input.runId !== "string") {
                    throw new Error("關閉請求格式錯誤。");
                }
                json(response, 200, await purchases.closeBrowser(input.runId));
                return;
            }

            if (request.method === "POST" && url.pathname === "/api/purchase") {
                // 檢查請求格式
                const input = await body(request);
                if (
                    Object.keys(input).some(
                        key => !["requestId", "activityId", "expectedActivity", "expectedContact"].includes(key),
                    ) ||
                    typeof input.requestId !== "string" ||
                    typeof input.activityId !== "string"
                ) {
                    throw new Error("購票請求格式錯誤。");
                }
                const requestId = input.requestId;
                notAccepted = () => !purchases.hasRequest(requestId);

                if ("expectedContact" in input) throw new Error("TicketPlus 不接受聯絡資料。");

                // 確認使用者看過的設定，和存檔內容一致
                const expectedActivity = parseActivity(input.expectedActivity);
                const activity = await store.load(input.activityId);
                if (JSON.stringify(activity.settings) !== JSON.stringify(expectedActivity)) {
                    throw new Error("活動設定已變更，請重新載入、儲存並確認摘要。");
                }
                json(response, 200, purchases.start(input.requestId, activity.settings, activity.id));
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
                if (purchases.busy()) {
                    throw new Error("執行或瀏覽器占用中，不能刪除活動。");
                }
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

            json(response, 404, { error: "找不到此功能。" });
        } catch (error) {
            // 設定與購票只回傳固定驗證訊息；檔案系統細節不輸出。
            const message = error instanceof Error && !("code" in error) ? error.message : "本機資料處理失敗。";
            if (!response.headersSent) json(response, 400, { error: message, notAccepted: notAccepted?.() });
            else response.end();
        } finally {
            releaseMutation?.();
        }
    });

    // 啟動伺服器，只接受本機連線
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

    // 回傳網址，以及關閉服務的方法
    return {
        url: origin,
        async close() {
            purchases.close();
            for (const stream of streams) stream.end();
            await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        },
    };
}
