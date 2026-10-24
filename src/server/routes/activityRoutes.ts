import type { ActivityStore } from "../../storage/activityStore.js";
import { json, readJsonBody, type ApiRequest } from "../http.js";
import type { PurchaseRuns } from "../runs/purchaseRuns.js";

interface ActivityServices {
    store: ActivityStore;
    purchases: PurchaseRuns;
}

// 處理活動列表、讀取、新增、修改與刪除；不是這些路徑時回傳 false。
export async function handleActivityRoute(api: ApiRequest, services: ActivityServices): Promise<boolean> {
    const { request, response, url } = api;
    const { store, purchases } = services;

    if (request.method === "GET" && url.pathname === "/api/activities") {
        const result = await store.list();
        json(response, 200, {
            ...result,
            activities: result.activities.map(activity => ({
                ...activity,
                executionStatus: purchases.activityStatus(activity),
            })),
        });
        return true;
    }

    const match = /^\/api\/activities\/([^/]+)$/.exec(url.pathname);

    if (request.method === "DELETE" && match) {
        if (purchases.busy()) {
            throw new Error("執行或瀏覽器占用中，不能刪除活動。");
        }
        await store.remove(match[1]!);
        json(response, 200, { deleted: true });
        return true;
    }

    if (request.method === "GET" && match) {
        json(response, 200, await store.load(match[1]!));
        return true;
    }

    if (request.method === "POST" && url.pathname === "/api/activities") {
        json(response, 201, await store.save(await readJsonBody(request)));
        return true;
    }

    if (request.method === "PUT" && match) {
        const input = await readJsonBody(request);
        const revision = request.headers["x-activity-revision"];
        if (revision !== undefined && revision !== (await store.load(match[1]!)).updatedAt) {
            throw new Error("活動設定已被其他分頁修改，請重新載入並確認。");
        }
        json(response, 200, await store.save(input, match[1]!));
        return true;
    }

    return false;
}
