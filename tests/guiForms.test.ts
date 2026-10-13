import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("完整GUI：設定保存、個資未存阻擋、真實fixture與重連保留結果", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-gui-"));
    const store = new ActivityStore(join(dir, "events"));
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(service.url);
        await page.locator("#new").click();
        await page.locator("#eventName").fill("UNKNOWN");
        await page.locator("#eventUrl").fill("https://www.klook.com/zh-TW/event-detail/fixture/");
        await page.locator("[name=date]").fill("2026-11-02");
        await page.locator("[name=time]").fill("19:30");
        await page.locator("[name=area]").fill("B區");
        await page.getByRole("button", { name: "下一步" }).click();
        await page.locator("#firstName").fill("Demo");
        await page.locator("#lastName").fill("Test");
        await page.locator("#phone").fill("0912345678");
        await page.locator("#email").fill("demo@example.com");
        await page.getByRole("button", { name: "下一步" }).click();
        await page.locator("#summary").filter({ hasText: "B區" }).waitFor();
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isEnabled());
        await page.getByRole("button", { name: "② 聯絡資料" }).click();
        await page.locator("#phone").fill("0999999999");
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isDisabled());
        await page.getByRole("button", { name: "② 聯絡資料" }).click();
        let releaseSave: () => void = () => {};
        const saveGate = new Promise<void>(resolve => (releaseSave = resolve));
        let receivedSave: () => void = () => {};
        const saveReceived = new Promise<void>(resolve => (receivedSave = resolve));
        await page.route("**/api/contact", async route => {
            if (route.request().method() === "PUT") {
                receivedSave();
                await saveGate;
            }
            await route.continue();
        });
        await page.getByRole("button", { name: "下一步" }).click();
        await saveReceived;
        assert(await page.locator("#phone").isDisabled());
        assert(await page.locator("#homeButton").isDisabled());
        releaseSave();
        await page.locator("#step3").waitFor({ state: "visible" });
        assert.equal(await page.getByRole("button", { name: "模擬執行（不購票）" }).count(), 0);
        await page.locator("#homeButton").click();
        await page.locator("#activities .activity-status").filter({ hasText: "尚無執行紀錄" }).waitFor();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        const original = (await store.list()).activities[0]!;
        await store.save(
            { ...original.settings, targets: original.settings.targets.map(t => ({ ...t, area: "C區" })) },
            original.id,
        );
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: "活動或聯絡資料已變更" }).waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), null);
        await store.save(original.settings, original.id);
        await page.locator("#start").click();
        await page.getByText("購票已停止", { exact: true }).waitFor();
        await page.waitForFunction(() =>
            document.querySelector("#instruction")!.textContent!.includes("購票程序已結束"),
        );
        await page.locator("#homeButton").click();
        assert(await page.locator("#viewRun").isHidden());
        assert(await page.locator("#homeRun").isHidden());
        await page.reload();
        await page.locator("#home").waitFor();
        await page.waitForFunction(() => document.querySelector("#status")!.textContent === "尚未執行");
        assert(await page.locator("#viewRun").isHidden());
        await page.waitForTimeout(200);
        assert.equal(await page.locator("#status").textContent(), "尚未執行");
        const html = await (await fetch(service.url)).text();
        const headers = { "X-Local-Token": /<meta name="local-token" content="([^"]+)"/.exec(html)![1]! };
        assert.equal((await (await fetch(service.url + "/api/purchase", { headers })).json()).status, "unknown");
        assert.doesNotMatch((await page.locator("#logs").textContent()) ?? "", /0999999999|demo@example.com/);
        await page.screenshot({ path: "/tmp/ticketpilot-gui-phase6.png", fullPage: true });
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("首頁只顯示占用或執行中的狀態，結束紀錄仍保留", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-home-status-"));
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        for (const status of ["running", "payment-ready", "failed", "unknown", "interrupted"]) {
            const page = await browser.newPage();
            // 以攔截回應呈現真實 SSE 快照，不啟動購票。
            const run = {
                id: "fixture",
                requestId: "fixture",
                activityName: "測試活動",
                status,
                occupied: true,
                browserOpen: true,
                message: "測試狀態",
                events: [],
                historyTruncated: false,
            };
            await page.route("**/api/purchase", route => route.fulfill({ json: run }));
            const feed = await snapshotFeed(page, "/api/purchase/events", run);
            await page.goto(service.url);
            await page.locator("#viewRun").waitFor();
            assert.equal(await page.locator("#viewRun").textContent(), "查看目前狀態");
            assert(await page.locator("#new").isDisabled());
            if (status === "payment-ready")
                assert.match((await page.locator("#homeRun").textContent()) ?? "", /自動流程已完成/);
            await page.locator("#viewRun").click();
            await page.locator("#step4").waitFor();
            await page.locator("#homeButton").click();
            // 模擬接收到解除占用的下一個快照；不改變執行結果。
            feed.publish({ ...run, occupied: false, browserOpen: false });
            await eventually(async () => assert.equal(await page.locator("#homeRun").textContent(), ""));
            assert(await page.locator("#viewRun").isHidden());
            assert(await page.locator("#homeRun").isHidden());
            assert.equal(
                await page.locator("#status").textContent(),
                status === "running" ? "正在購票" : status === "payment-ready" ? "已到付款頁" : "購票已停止",
            );
            await page.waitForFunction(() => !(document.querySelector("#new") as HTMLButtonElement).disabled);
            assert(await page.locator("#new").isEnabled());
            await page.close();
        }
        const page = await browser.newPage();
        const simulation = { id: "simulation", status: "running", events: [], historyTruncated: false };
        const feed = await snapshotFeed(page, "/api/events", simulation);
        const purchaseFeed = await snapshotFeed(page, "/api/purchase/events");
        await page.goto(service.url);
        await page.locator("#viewRun").filter({ hasText: "查看模擬狀態" }).click();
        await page.locator("#step4").waitFor();
        feed.publish({ ...simulation, status: "completed" });
        await page.getByText("模擬完成（未購票）", { exact: true }).waitFor();
        purchaseFeed.publish({
            id: "other",
            status: "running",
            occupied: true,
            browserOpen: true,
            activityName: "另一場",
            events: [],
            historyTruncated: false,
        });
        await eventually(async () =>
            assert.match((await page.locator("#homeRun").textContent()) ?? "", /購票流程執行中/),
        );
        assert.match(await page.locator("#logs").innerText(), /模擬執行紀錄/);
        assert.equal(await page.locator("#status").innerText(), "模擬完成（未購票）");
        purchaseFeed.publish(null);
        await eventually(async () => assert.equal(await page.locator("#homeRun").textContent(), ""));
        await page.locator("#homeButton").click();
        assert(await page.locator("#viewRun").isHidden());
        assert(await page.locator("#homeRun").isHidden());
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("結束後關閉瀏覽器：確認取消、付款提醒、解除占用及舊紀錄拒絕", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-close-ui-"));
    const store = new ActivityStore(join(dir, "events"));
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url),
    });
    const browser = await chromium.launch();
    const contact = {
        firstName: "Demo",
        lastName: "Test",
        regionLabel: "台灣 (+886)",
        phone: "0912345678",
        email: "fixture@example.com",
    };
    const html = await (await fetch(service.url)).text();
    const headers = {
        "X-Local-Token": html.match(/<meta name="local-token" content="([^"]+)"/)![1]!,
        "Content-Type": "application/json",
    };
    let runId = "";
    try {
        await fetch(service.url + "/api/contact", { method: "PUT", headers, body: JSON.stringify(contact) });
        const page = await browser.newPage();
        await page.goto(service.url);
        for (const eventName of ["HOLD_PAYMENT", "HOLD_FAILED", "HOLD_UNKNOWN"]) {
            const activity = await store.save({
                eventName,
                platform: "klook",
                eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
                fallbackMode: "STRICT",
                excludeKeywords: [],
                targets: [
                    { date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false },
                ],
            });
            await page.reload();
            await page
                .locator("#activities tr")
                .filter({ hasText: eventName })
                .locator(".activity-status")
                .filter({ hasText: "尚無執行紀錄" })
                .waitFor();
            const started = await fetch(service.url + "/api/purchase", {
                method: "POST",
                headers,
                body: JSON.stringify({
                    requestId: crypto.randomUUID(),
                    activityId: activity.id,
                    expectedActivity: activity.settings,
                    expectedContact: contact,
                }),
            });
            runId = (await started.json()).id;
            await page.reload();
            await page.locator("#viewRun").click();
            const close = page.getByRole("button", { name: "關閉購票瀏覽器", exact: true });
            await close.waitFor();
            let prompt = "";
            page.once("dialog", async dialog => {
                prompt = dialog.message();
                await dialog.dismiss();
            });
            await close.click();
            if (eventName === "HOLD_PAYMENT") assert.match(prompt, /付款/);
            assert.equal((await (await fetch(service.url + "/api/purchase", { headers })).json()).browserOpen, true);
            assert.equal(
                (
                    await fetch(service.url + "/api/purchase/close-browser", {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ runId: "old" }),
                    })
                ).status,
                400,
            );
            assert.equal(
                (
                    await fetch(service.url + "/api/purchase/close-browser", {
                        method: "POST",
                        body: JSON.stringify({ runId }),
                    })
                ).status,
                403,
            );
            page.once("dialog", dialog => dialog.accept());
            await close.click();
            await page.waitForFunction(() => {
                const text = document.querySelector("#instruction")!.textContent!;
                return text.includes("已關閉。本程式") || text.includes("購票程序已結束");
            });
            assert(await page.locator("#closeBrowser").isHidden());
            await page.locator("#homeButton").click();
            await page.waitForFunction(() => !(document.querySelector("#new") as HTMLButtonElement).disabled);
            assert(await page.locator("#new").isEnabled());
            await page
                .locator("#activities tr")
                .filter({ hasText: eventName })
                .locator(".activity-status")
                .filter({ hasText: "已執行" })
                .waitFor();
        }
    } finally {
        if (runId)
            await fetch(service.url + "/api/purchase/close-browser", {
                method: "POST",
                headers,
                body: JSON.stringify({ runId }),
            });
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("舊價格活動可載入，無金額表單仍可保存、摘要及重載", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-gui-currency-"));
    const store = new ActivityStore(join(dir, "events"));
    const record = await store.save({
        eventName: "港幣測試",
        platform: "klook",
        eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
        fallbackMode: "STRICT",
        excludeKeywords: [],
        targets: [{ date: "2026-11-20", time: "19:00", area: "VIP", unitPrice: 1699, quantity: 1, adjacent: false }],
    });
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        // 表單不再要求幣別或價格
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(service.url);
        await page.getByText("使用活動", { exact: true }).click();
        await page.locator("#step1").waitFor({ state: "visible" });
        assert.equal(await page.locator("#currency, [name=unitPrice]").count(), 0);
        await page.getByRole("button", { name: "下一步" }).click();
        await page.locator("#step2").waitFor({ state: "visible" });
        assert.equal("currency" in (await store.load(record.id)).settings, false);

        // 無價格也能完成聯絡資料保存與摘要
        await page.locator("#firstName").fill("Demo");
        await page.locator("#lastName").fill("Test");
        await page.locator("#phone").fill("0912345678");
        await page.locator("#email").fill("demo@example.com");
        await page.getByRole("button", { name: "下一步" }).click();
        await page.locator("#summary").filter({ hasText: "VIP" }).waitFor();
        assert.match(await page.locator("#summary").innerText(), /VIP/);
        assert.doesNotMatch(await page.locator("#summary").innerText(), /NT\$1699/);
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isEnabled());

        // 重載活動無價格欄位，也沒有模組載入錯誤
        await page.reload();
        await page.getByText("使用活動", { exact: true }).click();
        await page.locator("#step1").waitFor({ state: "visible" });
        assert.equal(await page.locator("#currency, [name=unitPrice]").count(), 0);
        assert.deepEqual(errors, []);
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});
