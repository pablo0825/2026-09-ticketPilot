import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { enterTicketPlus, eventually } from "./fixtures/guiTestHelpers.js";
import { pendingStartKey } from "../src/gui/shared/runs/pendingStart.js";

const activity = { schemaVersion: 3, id: "fixture-activity", updatedAt: "2026-10-20T00:00:00Z", settings: apiActivity };
const run = {
    id: "shared-run",
    requestId: "shared-request",
    activityName: "測試活動",
    platform: "ticketplus",
    status: "payment-ready",
    occupied: true,
    browserOpen: true,
    canCloseBrowser: true,
    events: [],
    historyTruncated: false,
};

async function fixture(work: (page: Page, url: string, feed: { publish: (value: unknown) => void }) => Promise<void>) {
    let snapshot: unknown = null;
    const feed = {
        publish: (value: unknown) => {
            snapshot = value;
        },
    };
    const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL("../", import.meta.url)),
        server: { host: "127.0.0.1", port: 0 },
        esbuild: { jsx: "automatic" },
        optimizeDeps: {
            noDiscovery: true,
            include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
        },
    });
    // 保持真實 SSE 連線，避免短串流重連訊息覆蓋正在驗證的操作錯誤。
    server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/purchase/events?")) return next();
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const send = () => response.write(`data: ${JSON.stringify(snapshot)}\n\n`);
        send();
        const interval = setInterval(send, 30);
        response.on("close", () => clearInterval(interval));
    });
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
        await server.listen();
        browser = await chromium.launch();
        const page = await browser.newPage();
        await page.route("**/api/activities", route =>
            route.fulfill({ json: { activities: [{ ...activity, executionStatus: "尚未執行" }], invalidFiles: 0 } }),
        );
        await page.route("**/api/activities/fixture-activity", route => route.fulfill({ json: activity }));
        await page.route("**/api/purchase", route => route.fulfill({ json: null }));
        const url = server.resolvedUrls?.local[0];
        assert.ok(url);
        await work(page, url + "tests/fixtures/platformWorkspaces.html", feed);
    } finally {
        await browser?.close();
        await server.close();
    }
}

function platform(page: Page, name: string) {
    return page.getByRole("button", { name: `進入 ${name}`, exact: true });
}

test("兩平台 App：TicketPlus 草稿取消離開保留，確認後載入假平台，返回可繼續編輯", async () => {
    await fixture(async (page, url) => {
        await page.goto(url);
        await enterTicketPlus(page);
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        await page.getByLabel("活動名稱", { exact: true }).fill("未保存草稿");
        page.once("dialog", dialog => dialog.dismiss());
        await page.locator("#brandHome").click();
        assert.equal(await page.getByLabel("活動名稱", { exact: true }).inputValue(), "未保存草稿");
        assert.equal(await page.getByRole("heading", { name: "Fixture Platform Only" }).count(), 0);
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#brandHome").click();
        await platform(page, "測試平台").click();
        await page.getByRole("heading", { name: "Fixture Platform Only" }).waitFor();
        await page.getByRole("button", { name: "返回平台首頁", exact: true }).click();
        await platform(page, "TicketPlus").click();
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        assert.equal(await page.getByLabel("活動名稱", { exact: true }).inputValue(), apiActivity.eventName);
    });
});

test("兩平台 App：保存進行中不能卸載工作區，完成後才能切換", async () => {
    await fixture(async (page, url) => {
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let writes = 0;
        await page.route("**/api/activities/fixture-activity", async route => {
            if (route.request().method() !== "PUT") return route.fulfill({ json: activity });
            writes++;
            await gate;
            await route.fulfill({ json: { ...activity, settings: route.request().postDataJSON() } });
        });
        await page.goto(url);
        await enterTicketPlus(page);
        await page.getByRole("button", { name: "編輯活動", exact: true }).click();
        await page.getByLabel("活動名稱", { exact: true }).fill("保存中");
        await page.locator("#saveActivity").click();
        try {
            await eventually(async () => assert.equal(writes, 1));
            assert(await page.locator("#brandHome").isDisabled());
            assert.equal(await page.getByRole("heading", { name: "Fixture Platform Only" }).count(), 0);
        } finally {
            release();
        }
        await page.getByRole("button", { name: "開始購票", exact: true }).waitFor();
        await page.locator("#brandHome").click();
        await platform(page, "測試平台").click();
        await page.getByRole("heading", { name: "Fixture Platform Only" }).waitFor();
        assert.equal(writes, 1);
    });
});

test("兩平台 App：未知及損壞 pending 阻擋切換，共用入口查詢不送出啟動", async () => {
    await fixture(async (page, url) => {
        let writes = 0;
        page.on("request", request => {
            if (["POST", "PUT", "DELETE"].includes(request.method())) writes++;
        });
        for (const raw of [
            JSON.stringify({
                version: 2,
                platform: "ticketplus",
                requestId: "unknown",
                activityId: activity.id,
                signature: "old",
            }),
            "broken",
        ]) {
            await page.goto(url);
            await enterTicketPlus(page);
            await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
            await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key: pendingStartKey, raw });
            await page.locator("#brandHome").click();
            await page.getByRole("region", { name: "待確認的啟動請求" }).waitFor();
            assert.equal(await page.getByRole("heading", { name: "Fixture Platform Only" }).count(), 0);
            await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
            await eventually(async () => assert.match(await page.locator("#message").innerText(), /無法核對|無法讀取/));
            assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingStartKey), raw);
            assert(await platform(page, "TicketPlus").isDisabled());
            assert(await platform(page, "測試平台").isDisabled());
            await page.evaluate(key => sessionStorage.removeItem(key), pendingStartKey);
        }
        assert.equal(writes, 0);
    });
});

test("兩平台 App：切換保留全域執行狀態與占用，關閉期間禁止切換", async () => {
    await fixture(async (page, url, feed) => {
        feed.publish(run);
        let initialReads = 0;
        await page.route("**/api/purchase", route => {
            initialReads++;
            return route.fulfill({ json: run });
        });
        await page.goto(url);
        await enterTicketPlus(page);
        await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        await page.locator("#brandHome").click();
        await platform(page, "測試平台").click();
        await eventually(async () => assert.equal(await page.getByTestId("run-id").innerText(), run.id));
        assert.equal(await page.getByTestId("occupied").innerText(), "true");
        await page.getByRole("button", { name: "返回平台首頁", exact: true }).click();
        await platform(page, "TicketPlus").click();
        await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        assert(await page.locator("#new").isDisabled());
        await page.locator("#brandHome").click();
        await platform(page, "測試平台").click();
        await page.getByRole("button", { name: "查看全域執行狀態" }).click();
        await page.locator("#status").waitFor();
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let closes = 0;
        await page.route("**/api/purchase/close-browser", async route => {
            closes++;
            await gate;
            const closed = { ...run, occupied: false, browserOpen: false, canCloseBrowser: false };
            feed.publish(closed);
            await route.fulfill({ json: closed });
        });
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#closeBrowser").click();
        try {
            await eventually(async () => assert.equal(closes, 1));
            assert(await page.locator("#brandHome").isDisabled());
        } finally {
            release();
        }
        await eventually(async () => assert(await page.locator("#brandHome").isEnabled()));
        await page.locator("#brandHome").click();
        await platform(page, "TicketPlus").click();
        await eventually(async () => assert(await page.locator("#new").isEnabled()));
        assert.equal(initialReads, 1);
    });
});

test("正式 GUI 產物不包含測試平台工作區", async () => {
    const directory = new URL("../dist/react/assets/", import.meta.url);
    for (const file of await readdir(directory)) {
        if (file.endsWith(".js"))
            assert.doesNotMatch(await readFile(new URL(file, directory), "utf8"), /Fixture Platform Only/);
    }
});

test("兩平台 App：從假平台核對 TicketPlus 原請求，接受後只顯示原結果、不另啟一輪", async () => {
    await fixture(async (page, url) => {
        let writes = 0;
        page.on("request", request => {
            if (["POST", "PUT", "DELETE"].includes(request.method())) writes++;
        });
        await page.goto(url);
        await enterTicketPlus(page);
        await page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        await page.locator("#brandHome").click();
        await platform(page, "測試平台").click();
        await page.getByRole("heading", { name: "Fixture Platform Only" }).waitFor();
        const pending = {
            version: 2,
            platform: "ticketplus",
            requestId: run.requestId,
            activityId: activity.id,
            signature: "old",
        };
        await page.evaluate(({ key, pending }) => sessionStorage.setItem(key, JSON.stringify(pending)), {
            key: pendingStartKey,
            pending,
        });
        await page.route("**/api/purchase", route => route.fulfill({ json: run }));
        await page.getByRole("button", { name: "返回平台首頁", exact: true }).click();
        assert(await platform(page, "TicketPlus").isDisabled());
        assert.equal(await page.getByRole("heading", { name: "Fixture Platform Only" }).count(), 0);
        await page.getByRole("button", { name: "查看待確認的啟動結果", exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到付款頁"));
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), pendingStartKey), null);
        assert.equal(writes, 0);
    });
});
