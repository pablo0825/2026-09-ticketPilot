import { PurchaseRuns } from "./runs/purchaseRuns.js";
import { createServer, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { ActivityStore } from "../storage/activityStore.js";
import { json, type ApiRequest } from "./http.js";
import { serveStatic } from "./staticAssets.js";
import { handlePurchaseRoute } from "./routes/purchaseRoutes.js";
import { handleActivityRoute } from "./routes/activityRoutes.js";

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

    const purchaseServices = { purchases, store, streams };
    const activityServices = { store, purchases };

    let origin = "";
    let mutationTail = Promise.resolve();

    const server = createServer(async (request, response) => {
        let releaseMutation: (() => void) | undefined;
        // 在 try 之前宣告，讓錯誤處理能讀到路由設定的 notAccepted。
        let api: ApiRequest | undefined;

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

            // 以下依網址處理各個 API；錯誤統一由下方處理，路由不自行回應錯誤。
            api = { request, response, url };
            if (await handlePurchaseRoute(api, purchaseServices)) return;
            if (await handleActivityRoute(api, activityServices)) return;

            json(response, 404, { error: "找不到此功能。" });
        } catch (error) {
            // 設定與購票只回傳固定驗證訊息；檔案系統細節不輸出。
            const message = error instanceof Error && !("code" in error) ? error.message : "本機資料處理失敗。";

            if (!response.headersSent) json(response, 400, { error: message, notAccepted: api?.notAccepted?.() });
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
