import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { ActivityStore } from "../src/storage/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("React 正式打包由本機同源載入，保留 API 驗證與資源邊界", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-react-asset-"));
    const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
        runDirectory: join(directory, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        const response = await page.goto(service.url);
        await page.locator("#new").click();
        await page.getByLabel("活動名稱", { exact: true }).waitFor();
        assert.match(response!.headers()["content-security-policy"]!, /frame-ancestors 'none'/);
        assert.equal(response!.headers()["cache-control"], "no-store");
        assert.equal(
            await page
                .locator("h1")
                .evaluate(
                    el =>
                        Number.parseFloat(getComputedStyle(el).fontSize) /
                        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
                ),
            1.875, // text-3xl，確認打包後的 Tailwind utility 生效。
        );
        assert.equal(await page.locator("html").evaluate(el => getComputedStyle(el).fontSize), "15px");
        // Tailwind 基礎規則與實際欄位的 utility 各自生效。
        await page.evaluate(() => {
            const migrated = document.createElement("div");
            migrated.dataset.tailwind = "";
            migrated.id = "styleProbe";
            migrated.innerHTML = '<input aria-label="樣式隔離測試"><div hidden>隱藏內容</div>';
            document.querySelector("main")!.append(migrated);
        });
        assert.equal(
            await page.locator("#styleProbe input").evaluate(el => getComputedStyle(el).borderTopWidth),
            "0px",
        );
        assert.equal(await page.locator("#eventName").evaluate(el => getComputedStyle(el).borderTopWidth), "1px");
        assert.equal(await page.locator("#styleProbe [hidden]").isVisible(), false);
        assert.deepEqual(errors, []);

        const token = await page.locator('meta[name="local-token"]').getAttribute("content");
        assert.match(token!, /^[a-f0-9]{64}$/);
        assert.equal((await fetch(service.url + "/api/activities")).status, 403);
        assert.equal(
            (
                await fetch(service.url + "/api/activities", {
                    headers: { "X-Local-Token": token!, Origin: "https://other.example" },
                })
            ).status,
            403,
        );
        for (const path of ["/assets/%2e%2e%2fpackage.json", "/assets/package.json", "/src/local/server.ts"]) {
            assert.equal((await fetch(service.url + path, { headers: { "X-Local-Token": token! } })).status, 404);
        }
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
