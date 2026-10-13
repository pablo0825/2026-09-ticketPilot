import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { saveContactDetails } from "../src/config/contact.config.js";
import { startLocalServer } from "../src/local/server.js";

test("啟動已接受但回應遺失：重載再操作沿用請求，只啟動一個子程序", async () => {
    // 真實服務與獨立資料夾；子程序只記錄啟動次數。
    const directory = await mkdtemp(join(tmpdir(), "ticket-request-"));
    const store = new ActivityStore(join(directory, "events"));
    await store.save({
        eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
        eventName: "回應遺失測試",
        fallbackMode: "STRICT",
        excludeKeywords: [],
        targets: [{ date: "2026-11-02", time: "19:30", area: "A區", quantity: 2, adjacent: false }],
    });
    await saveContactDetails(
        {
            firstName: "Demo",
            lastName: "Test",
            regionLabel: "台灣 (+886)",
            phone: "0912345678",
            email: "fixture@example.com",
        },
        join(directory, "contact.json"),
    );
    const service = await startLocalServer(store, {
        contactPath: join(directory, "contact.json"),
        runDirectory: join(directory, "runtime"),
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    const html = await (await fetch(service.url)).text();
    const token = /const token = "([^"]+)"/.exec(html)![1]!;
    const waitUntilIdle = async () => {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            const response = await fetch(service.url + "/api/purchase", { headers: { "X-Local-Token": token } });
            const run = await response.json();
            if (!run || (!run.occupied && run.status !== "running")) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail("測試子程序未在期限內結束");
    };
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const ids: string[] = [];
        const runIds: string[] = [];
        let responseAborted = false;
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            ids.push(route.request().postDataJSON().requestId);
            const accepted = await route.fetch();
            assert.equal(accepted.status(), 200);
            runIds.push((await accepted.json()).id);
            if (ids.length === 1) {
                await waitUntilIdle();
                await route.abort();
                responseAborted = true;
            } else await route.fulfill({ response: accepted });
        });

        // 第一次送到真正後端後丟棄回應，不能清除待確認請求。
        await page.goto(service.url);
        await page.getByText("使用活動", { exact: true }).click();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: /.+/ }).waitFor();
        assert.equal(responseAborted, true);
        const pending = await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request"));
        assert(pending);
        assert.equal(JSON.parse(pending).requestId, ids[0]);

        // 載入同一設定再次操作，後端須回傳原紀錄而非重開子程序。
        await page.reload();
        await page.getByText("使用活動", { exact: true }).click();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#step4").waitFor();
        assert.equal(ids.length, 2);
        assert.equal(ids[1], ids[0]);
        assert.equal(runIds[1], runIds[0]);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), null);
        assert.equal(await readFile(join(directory, "runtime", "worker-starts.txt"), "utf8"), "started\n");
    } finally {
        await browser.close();
        try {
            await waitUntilIdle();
            await service.close();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
});
