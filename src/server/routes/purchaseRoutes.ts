import type { ServerResponse } from "node:http";
import { parseActivity } from "../../config/activitySettings.js";
import type { ActivityStore } from "../../storage/activityStore.js";
import { json, readJsonBody, type ApiRequest } from "../http.js";
import type { PurchaseRuns } from "../runs/purchaseRuns.js";

interface PurchaseServices {
    purchases: PurchaseRuns;
    store: ActivityStore;
    // 由服務關閉時統一結束，所以由 server.ts 建立後傳入。
    streams: Set<ServerResponse>;
}

// 處理執行狀態、啟動、停止、人工確認與關閉瀏覽器；不是這些路徑時回傳 false。
export async function handlePurchaseRoute(api: ApiRequest, services: PurchaseServices): Promise<boolean> {
    const { request, response, url } = api;
    const { purchases, store, streams } = services;

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
        return true;
    }

    if (request.method === "GET" && url.pathname === "/api/purchase") {
        json(response, 200, purchases.snapshot());
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/purchase/stop") {
        const input = await readJsonBody(request);
        if (Object.keys(input).length !== 1 || typeof input.runId !== "string" || !input.runId.trim()) {
            throw new Error("停止請求格式錯誤。");
        }
        json(response, 200, await purchases.stop(input.runId));
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/purchase/confirm-login") {
        const input = await readJsonBody(request);
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
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/purchase/confirm-participants") {
        const input = await readJsonBody(request);
        if (
            Object.keys(input).length !== 2 ||
            typeof input.runId !== "string" ||
            !input.runId.trim() ||
            typeof input.confirmationId !== "string"
        ) {
            throw new Error("參加者確認請求格式錯誤。");
        }
        json(response, 200, await purchases.confirmParticipants(input.runId, input.confirmationId));
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/purchase/close-browser") {
        const input = await readJsonBody(request);
        if (Object.keys(input).some(key => key !== "runId") || typeof input.runId !== "string") {
            throw new Error("關閉請求格式錯誤。");
        }
        json(response, 200, await purchases.closeBrowser(input.runId));
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/purchase") {
        // 檢查請求格式
        const input = await readJsonBody(request);
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
        // 保持延後判斷：啟動途中出錯時，紀錄可能已寫入，必須回報為已接受。
        api.notAccepted = () => !purchases.hasRequest(requestId);

        if ("expectedContact" in input) throw new Error("TicketPlus 不接受聯絡資料。");

        // 確認使用者看過的設定，和存檔內容一致
        const expectedActivity = parseActivity(input.expectedActivity);
        const activity = await store.load(input.activityId);
        if (JSON.stringify(activity.settings) !== JSON.stringify(expectedActivity)) {
            throw new Error("活動設定已變更，請重新載入、儲存並確認摘要。");
        }
        json(response, 200, purchases.start(input.requestId, activity.settings, activity.id));
        return true;
    }

    return false;
}
