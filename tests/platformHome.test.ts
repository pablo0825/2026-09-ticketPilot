import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type Page } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { saveContactDetails } from "../src/config/contact.config.js";
import { startLocalServer } from "../src/local/server.js";
import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

const settings = {
    platform: "klook",
    eventName: "平台首頁測試",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-21", time: "19:30", area: "B區", quantity: 2, adjacent: true }],
};
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "demo@example.com",
};

async function fixture(
    work: (page: Page, url: string, store: ActivityStore, id: string, dir: string) => Promise<void>,
    corruptContact = false,
) {
    const dir = await mkdtemp(join(tmpdir(), "ticket-platform-home-"));
    const store = new ActivityStore(join(dir, "events"));
    const record = await store.save(settings);
    const contactPath = join(dir, "contact.json");
    if (corruptContact) await writeFile(contactPath, "{invalid");
    else await saveContactDetails(contact, contactPath);
    const service = await startLocalServer(store, {
        contactPath,
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await work(page, service.url, store, record.id, dir);
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
}

async function openEditor(page: Page) {
    await page.locator("#selectKlook").click();
    await page.locator("#activities").getByText("編輯活動").click();
    await page.locator("#step1").waitFor();
}

test("平台首頁不讀 Klook 個資；TicketPlus 提供設定入口，個資損壞可返回首頁", async () => {
    await fixture(async (page, url) => {
        let contactReads = 0;
        let writes = 0;
        page.on("request", request => {
            if (new URL(request.url()).pathname === "/api/contact") contactReads++;
            if (["PUT", "POST", "DELETE"].includes(request.method())) writes++;
        });
        await page.goto(url);
        await page.locator("#selectKlook").waitFor();
        assert.equal(await page.getByRole("heading", { name: "TicketPilot" }).count(), 1);
        assert.equal(await page.locator("#platformHomeButton").count(), 0);
        assert.equal(contactReads, 0);
        const ticketPlus = page.getByRole("row").filter({ hasText: "TicketPlus" });
        assert.match(await ticketPlus.innerText(), /可進入設定/);
        assert.equal(await ticketPlus.getByRole("button", { name: "進入平台" }).count(), 1);
        await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "可使用"));
        assert.equal(await page.locator("#platformViewRun").count(), 0);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({ path: "/tmp/ticket-platform-home-desktop.png", fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: "/tmp/ticket-platform-home-mobile.png", fullPage: true });
        await page.locator("#selectKlook").click();
        await page
            .locator("#message")
            .filter({ hasText: /無法|格式|資料/ })
            .waitFor();
        assert(await page.locator("#new").isDisabled());
        await page.locator("#brandHome").click();
        await page.locator("#platformHome").waitFor();
        assert.equal(writes, 0);
    }, true);
});

test("離開確認取消保留草稿，確認放棄才卸載；舊活動重開不誤判未保存", async () => {
    await fixture(async (page, url, store, id, dir) => {
        // 用真正舊版檔案驗證載入相容，讀取不能升版或建立備份
        const { platform: _platform, ...oldSettings } = settings;
        const raw = JSON.stringify({
            schemaVersion: 1,
            id,
            updatedAt: "2026-10-01T00:00:00.000Z",
            settings: oldSettings,
        });
        const path = join(dir, "events", `${id}.json`);
        await writeFile(path, raw);
        await page.goto(url);
        await openEditor(page);
        let dialogs = 0;
        const dismiss = async (dialog: import("playwright").Dialog) => {
            dialogs++;
            await dialog.dismiss();
        };
        page.on("dialog", dismiss);
        await page.locator("#brandHome").click();
        await page.locator("#platformHome").waitFor();
        assert.equal(dialogs, 0);
        await openEditor(page);
        await page.locator("#eventName").fill("未保存的草稿");
        await page.locator("#brandHome").click();
        assert.equal(dialogs, 1);
        assert.equal(await page.locator("#eventName").inputValue(), "未保存的草稿");
        page.off("dialog", dismiss);
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "TicketPilot，返回平台首頁" }).focus();
        await page.keyboard.press("Enter");
        await openEditor(page);
        assert.equal(await page.locator("#eventName").inputValue(), settings.eventName);
        assert.equal(await readFile(path, "utf8"), raw);
        await assert.rejects(readFile(path + ".v1.bak"), { code: "ENOENT" });
        assert.equal((await store.load(id)).settings.platform, "klook");
        await page.screenshot({ path: "/tmp/ticket-klook-preserved.png", fullPage: true });
    });
});

test("保存與開始請求送出期間不能離開，完成後導航不產生第二筆購票", async () => {
    await fixture(async (page, url) => {
        let purchaseRequests = 0;
        page.on("request", request => {
            if (new URL(request.url()).pathname === "/api/purchase" && request.method() === "POST") {
                purchaseRequests++;
            }
        });
        await page.goto(url);
        await openEditor(page);
        for (const operation of ["save", "start"]) {
            let release: () => void = () => {};
            let received: () => void = () => {};
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            const arrived = new Promise<void>(resolve => {
                received = resolve;
            });
            const pattern = operation === "save" ? "**/api/activities/*" : "**/api/purchase";
            let requests = 0;
            await page.route(pattern, async route => {
                if (route.request().method() !== (operation === "save" ? "PUT" : "POST")) return route.continue();
                requests++;
                received();
                await gate;
                if (operation === "save") await route.continue();
                else
                    await route.fulfill({
                        json: {
                            id: "accepted",
                            status: "failed",
                            occupied: false,
                            browserOpen: false,
                            events: [],
                            message: "fixture 完成",
                        },
                    });
            });
            if (operation === "save") {
                await page.locator("#eventName").fill("已修改");
                await page.locator("#saveActivity").click();
            } else {
                await page.getByRole("button", { name: "確認與開始" }).click();
                await page.locator("#confirm").check();
                await page.locator("#start").click();
            }
            await arrived;
            try {
                assert(await page.locator("#brandHome").isDisabled());
                assert(await page.locator("#homeButton").isDisabled());
                assert.equal(await page.locator("#platformHome").count(), 0);
                assert.equal(requests, 1);
            } finally {
                release();
            }
            await page.locator(operation === "save" ? "#step2" : "#step4").waitFor();
            await eventually(async () => assert(await page.locator("#brandHome").isEnabled()));
            await page.unroute(pattern);
        }
        await page.locator("#brandHome").click();
        await page.locator("#platformHome").waitFor();
        await openEditor(page);
        assert.equal(purchaseRequests, 1);
    });
});

test("執行中返回平台首頁仍接收狀態，不能在 Klook 再開另一輪", async () => {
    await fixture(async (page, url) => {
        const initial = {
            id: "running",
            requestId: randomUUID(),
            platform: "klook",
            activityName: "占用中",
            status: "running",
            occupied: true,
            browserOpen: true,
            events: [],
            historyTruncated: false,
            message: "購票中",
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", initial);
        await page.goto(url);
        await page.locator("#platformViewRun").waitFor();
        await page.locator("#selectKlook").click();
        assert(await page.locator("#new").isDisabled());
        await page.locator("#brandHome").click();
        feed.publish({ ...initial, status: "payment-ready", message: "等待付款" });
        await page.locator("#platformViewRun").click();
        await eventually(async () => assert.match(await page.locator("main").innerText(), /已到付款頁/));
        await page.locator("#brandHome").click();
        await page.locator("#platformViewRun").waitFor();
    });
});

test("舊未知請求跨首頁導航保留，不保存、不建立新請求", async () => {
    await fixture(async (page, url, _store, id) => {
        await page.goto(url);
        const pending = JSON.stringify({ version: 2, requestId: randomUUID(), activityId: id, signature: "old" });
        await page.evaluate(value => sessionStorage.setItem("ticketpilot-purchase-request", value), pending);
        let writes = 0;
        page.on("request", request => {
            if (["PUT", "POST"].includes(request.method())) writes++;
        });
        await openEditor(page);
        await page.locator("#brandHome").click();
        await openEditor(page);
        await page.getByRole("button", { name: "確認與開始" }).click();
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: "舊版開始請求" }).waitFor();
        assert.equal(writes, 0);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), pending);
    });
});

test("平台列隨流程更新，僅進行中或待人工確認可查看；導航不發送購票請求", async () => {
    await fixture(async (page, url) => {
        // 初始購票與後續狀態由串流送達，確認按鈕位於 Klook 列
        const purchase = {
            id: "purchase",
            requestId: randomUUID(),
            platform: "klook",
            activityName: "狀態測試",
            status: "running",
            occupied: true,
            browserOpen: true,
            events: [],
            historyTruncated: false,
            message: "執行中",
        };
        const purchaseFeed = await snapshotFeed(page, "/api/purchase/events", purchase);
        let writes = 0;
        page.on("request", request => {
            if (["PUT", "POST", "DELETE"].includes(request.method())) writes++;
        });
        await page.goto(url);
        const row = page.getByRole("row").filter({ hasText: "Klook" });
        await row.getByRole("button", { name: "查看狀態" }).waitFor();
        await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "購票進行中"));

        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: "/tmp/ticket-platform-home-active-mobile.png", fullPage: true });

        // 等待開賣與瀏覽器占用都可查看，返回不會中斷訂閱
        purchaseFeed.publish({
            ...purchase,
            events: [{ at: new Date().toISOString(), event: { type: "state", state: "WAITING_FOR_SALE" } }],
        });
        await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "等待開賣"));
        await page.locator("#platformViewRun").click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "等待開賣"));
        await page.locator("#brandHome").click();
        purchaseFeed.publish({ ...purchase, status: "payment-ready" });
        await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "瀏覽器仍開啟"));

        // 正常終態及一般失敗不當作待確認，也不提供歷史結果入口
        for (const status of ["payment-ready", "failed"]) {
            purchaseFeed.publish({ ...purchase, status, occupied: false, browserOpen: false });
            await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "可使用"));
            assert.equal(await page.locator("#platformViewRun").count(), 0);
            assert.equal(await page.getByRole("button", { name: /最近.*結果/ }).count(), 0);
        }

        // 即使已解除占用，不確定結果仍可查看對應原因
        for (const status of ["unknown", "interrupted"]) {
            purchaseFeed.publish({ ...purchase, status, occupied: false, browserOpen: false });
            await eventually(async () =>
                assert.equal(await page.locator("#platformStatus").innerText(), "需要人工確認"),
            );
            await page.locator("#platformViewRun").click();
            await eventually(async () =>
                assert.match(
                    await page.locator("#instruction").innerText(),
                    status === "unknown" ? /提交結果尚未確認/ : /程序異常中斷/,
                ),
            );
            await page.locator("#brandHome").click();
        }

        purchaseFeed.publish({ ...purchase, status: "failed", occupied: false, browserOpen: false });
        await eventually(async () => assert.equal(await page.locator("#platformStatus").innerText(), "可使用"));
        assert.equal(await page.locator("#platformViewRun").count(), 0);
        assert.equal(await page.getByRole("button", { name: /最近.*結果/ }).count(), 0);
        assert.equal(writes, 0);
    });
});

test("點擊品牌返回前確認聯絡草稿，關閉瀏覽器期間兩種狀態頁都禁止離開", async () => {
    await fixture(async (page, url) => {
        // 聯絡資料仍走工作區的未儲存檢查
        await page.goto(url);
        await openEditor(page);
        await page.getByRole("button", { name: "聯絡資料" }).click();
        const input = page.locator("#firstName");
        await input.fill("未儲存");
        page.once("dialog", dialog => dialog.dismiss());
        await page.locator("#brandHome").click();
        assert.equal(await input.inputValue(), "未儲存");
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#brandHome").click();
        await page.locator("#platformHome").waitFor();

        // 根層與 Klook 狀態頁共用關閉中的禁止離開條件
        const run = {
            id: "closing",
            platform: "klook",
            activityName: "關閉測試",
            status: "payment-ready",
            occupied: true,
            browserOpen: true,
            canCloseBrowser: true,
            events: [],
            historyTruncated: false,
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", run);
        for (const workspace of [false, true]) {
            await page.reload();
            if (workspace) {
                await page.locator("#selectKlook").click();
                await page.locator("#viewRun").click();
            } else await page.locator("#platformViewRun").click();
            let release: () => void = () => {};
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            await page.route("**/api/purchase/close-browser", async route => {
                await gate;
                await route.fulfill({ json: run });
            });
            page.once("dialog", dialog => dialog.accept());
            await page.locator("#closeBrowser").click();
            try {
                await eventually(async () => assert(await page.locator("#brandHome").isDisabled()));
                assert.equal(await page.locator("#platformHome").count(), 0);
            } finally {
                release();
            }
            await eventually(async () => assert(await page.locator("#brandHome").isEnabled()));
            await page.unroute("**/api/purchase/close-browser");
            await page.locator("#brandHome").click();
            await page.locator("#platformHome").waitFor();
            feed.publish(run);
        }
    });
});

test("Klook 清單略過 TicketPlus，載入回應若變成其他平台也不能進入編輯", async () => {
    await fixture(async (page, url, store, id) => {
        // 真實列表包含兩平台，Klook 工作區只能顯示自己的活動
        const ticketplus = await store.save({
            platform: "ticketplus",
            eventUrl: "https://ticketplus.com.tw/activity/fixture",
            eventName: "TicketPlus 列表隔離測試",
            targets: [{ date: "2026-11-21", time: "19:30", ticketType: "預售票", quantity: 1 }],
        });
        await page.goto(url);
        await page.locator("#selectKlook").click();
        await page.locator("#activities").getByText("編輯活動").waitFor();
        assert.equal(await page.locator("#activities tr").count(), 1);
        assert.equal(await page.locator("#activities").getByText(ticketplus.settings.eventName).count(), 0);

        // 清單篩選不能代替讀取單筆時的平台驗證
        await page.route("**/api/activities/" + id, route => route.fulfill({ json: ticketplus }));
        await page.locator("#activities").getByText("編輯活動").click();
        await eventually(async () => {
            assert.match(await page.locator("#message").innerText(), /僅支援 Klook/);
        });
        assert.equal(await page.locator("#step1").isVisible(), false);
        assert.equal(await page.locator("#home").isVisible(), true);
    });
});

test("執行狀態依平台歸屬，外部未知占用不標成 Klook", async () => {
    await fixture(async (page, url) => {
        // TicketPlus 可進入設定，既有執行紀錄仍可從正確平台查看
        const purchase = {
            id: "platform-record",
            requestId: randomUUID(),
            platform: "ticketplus",
            activityName: "平台紀錄",
            status: "unknown",
            occupied: false,
            browserOpen: false,
            events: [],
            historyTruncated: false,
            message: "結果不明",
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", purchase);
        await page.goto(url);
        const klookRow = page.getByRole("row").filter({ hasText: "Klook" });
        const ticketplusRow = page.getByRole("row").filter({ hasText: "TicketPlus" });
        await ticketplusRow.getByRole("button", { name: "查看狀態" }).waitFor();
        assert.equal(await klookRow.getByRole("button", { name: "查看狀態" }).count(), 0);
        assert.equal(await ticketplusRow.getByRole("button", { name: "進入平台" }).count(), 1);
        await ticketplusRow.getByRole("button", { name: "查看狀態" }).click();
        await eventually(async () => assert.match(await page.locator("#logs").innerText(), /購票平台：TicketPlus/));

        // 未知占用在平台表格外呈現，仍能查看原因
        await page.locator("#brandHome").click();
        feed.publish({ ...purchase, platform: null, status: "interrupted", occupied: true });
        await eventually(async () =>
            assert.match(await page.locator("#platformHome").innerText(), /平台未知的購票程序/),
        );
        assert.equal(await klookRow.getByRole("button", { name: "查看狀態" }).count(), 0);
        assert.equal(await ticketplusRow.getByRole("button", { name: "查看狀態" }).count(), 0);
        await page.locator("#platformViewRun").click();
        await eventually(async () => assert.match(await page.locator("#logs").innerText(), /購票平台：未知/));
    });
});
