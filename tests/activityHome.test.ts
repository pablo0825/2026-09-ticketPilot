import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";
import { acquirePurchaseLease, releasePurchaseLease } from "../src/app/purchaseLock.js";
const settings = {
    eventName: "同名活動",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false }],
};

test("首頁場次摘要、未存離開、同名刪除及API占用與並發保護", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-home-"));
    const store = new ActivityStore(join(dir, "events"));
    const a = await store.save({
        ...settings,
        targets: [...settings.targets, { ...settings.targets[0], area: "C區" }],
    });
    const b = await store.save({
        ...settings,
        targets: [...settings.targets, { ...settings.targets[0], date: "2026-11-03" }],
    });
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(service.url);
        await page.locator("#activities tr").nth(1).waitFor();
        await page.screenshot({ path: "/tmp/activity-home.png", fullPage: true });
        assert.equal(await page.locator("#activities tr").filter({ hasText: "2026-11-02" }).count(), 1);
        assert.equal(await page.locator("#activities tr").filter({ hasText: "多個場次" }).count(), 1);
        await page.locator("#activities tr").filter({ hasText: "2026-11-02" }).getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        assert.equal(await page.locator("[name=area]").first().inputValue(), "B區");
        await page.locator("[name=area]").first().fill("D區");
        page.once("dialog", dialog => dialog.dismiss());
        await page.locator("#homeButton").click();
        assert.equal(await page.locator("[name=area]").first().inputValue(), "D區");
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#homeButton").click();
        await page.locator("#home").waitFor();
        assert.equal((await store.load(a.id)).settings.targets[0]!.area, "B區");
        const multi = page.locator("#activities tr").filter({ hasText: "多個場次" });
        page.once("dialog", dialog => dialog.dismiss());
        await multi.getByText("刪除", { exact: true }).click();
        assert.equal((await store.list()).activities.length, 2);
        page.once("dialog", dialog => dialog.accept());
        await multi.getByText("刪除", { exact: true }).click();
        await multi.waitFor({ state: "detached" });
        await assert.rejects(store.load(b.id));
        assert.equal((await store.list()).activities.length, 1);
        const html = await (await fetch(service.url)).text();
        const token = html.match(/const token = "([^"]+)"/)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        const lease = acquirePurchaseLease(join(dir, "runtime"));
        try {
            assert.equal(
                (await fetch(`${service.url}/api/activities/${a.id}`, { method: "DELETE", headers })).status,
                400,
            );
            assert.equal((await store.load(a.id)).id, a.id);
        } finally {
            releasePurchaseLease(lease);
        }
        // 無論哪個請求先取得序列，刪除成功後不能由舊 PUT 復活。
        const results = await Promise.all([
            fetch(`${service.url}/api/activities/${a.id}`, { method: "DELETE", headers }),
            fetch(`${service.url}/api/activities/${a.id}`, { method: "PUT", headers, body: JSON.stringify(settings) }),
        ]);
        assert.equal(results[0]!.status, 200);
        await assert.rejects(store.load(a.id));
        assert.equal((await fetch(`${service.url}/api/activities/${a.id}`, { method: "DELETE" })).status, 403);
        await page.reload();
        await page.locator("#emptyActivities").waitFor();
        await page.locator("#new").click();
        assert.equal(await page.locator("#eventName").inputValue(), "");
        await page.screenshot({ path: "/tmp/activity-home-editor.png", fullPage: true });
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("啟動與刪除並發只有一方成功，不刪個資或執行紀錄", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-home-start-"));
    const store = new ActivityStore(join(dir, "events"));
    const activity = await store.save(settings);
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url),
    });
    const html = await (await fetch(service.url)).text();
    const headers = { "X-Local-Token": html.match(/const token = "([^"]+)"/)![1]!, "Content-Type": "application/json" };
    const contact = {
        firstName: "Demo",
        lastName: "Test",
        regionLabel: "台灣 (+886)",
        phone: "0912345678",
        email: "fixture@example.com",
    };
    try {
        await fetch(service.url + "/api/contact", { method: "PUT", headers, body: JSON.stringify(contact) });
        const [started, deleted] = await Promise.all([
            fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    requestId: crypto.randomUUID(),
                    activityId: activity.id,
                    expectedActivity: settings,
                    expectedContact: contact,
                }),
            }),
            fetch(`${service.url}/api/activities/${activity.id}`, { method: "DELETE", headers }),
        ]);
        assert.notEqual(started.status === 200, deleted.status === 200);
        assert.deepEqual((await (await fetch(service.url + "/api/contact", { headers })).json()).contact, contact);
        if (started.status === 200) {
            for (let i = 0; i < 150; i++) {
                const run = await (await fetch(service.url + "/api/purchase", { headers })).json();
                if (!run.occupied) break;
                await new Promise(resolve => setTimeout(resolve, 30));
            }
            const previous = await (await fetch(service.url + "/api/purchase", { headers })).json();
            assert.equal(
                (await fetch(`${service.url}/api/activities/${activity.id}`, { method: "DELETE", headers })).status,
                200,
            );
            assert.equal((await (await fetch(service.url + "/api/purchase", { headers })).json()).id, previous.id);
        }
    } finally {
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
