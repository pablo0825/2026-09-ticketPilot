import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import type { Page, Browser } from "playwright";
import { acquirePurchaseLease, releasePurchaseLease } from "../../../src/storage/purchaseLock.js";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { startLocalServer } from "../../../src/server/server.js";
import { enterTicketPlus, eventually, snapshotFeed } from "../../fixtures/guiTestHelpers.js";

const settings = {
    platform: "ticketplus",
    eventName: "同名活動",
    eventUrl: "https://ticketplus.com.tw/activity/fixture",
    targets: [{ date: "2026-11-22", time: "18:00", ticketType: "A區", quantity: 1 }],
    maxRunMinutes: 10,
    saleSchedule: { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 },
};
const klook = {
    platform: "klook",
    eventName: "同名活動",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-21", time: "19:00", area: "K區", quantity: 1, adjacent: false }],
};
interface Harness {
    page: Page;
    browser: Browser;
    url: string;
    store: ActivityStore;
    id: string;
    directory: string;
    requests: { method: string; path: string }[];
}
async function fixture(work: (h: Harness) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-gui-"));
    const store = new ActivityStore(join(directory, "events"));
    const original = await store.save(settings);
    const klookPath = join(directory, "events", randomUUID() + ".json");
    const before = JSON.stringify({
        schemaVersion: 3,
        id: klookPath.split("/").at(-1)!.slice(0, -5),
        updatedAt: "2026-10-01T00:00:00.000Z",
        settings: klook,
    });
    await writeFile(klookPath, before);
    // 刻意讓聯絡設定損壞，TicketPlus 設定不應依賴它。
    const contactPath = join(directory, "contact.json");
    await writeFile(contactPath, "{broken-contact");
    const service = await startLocalServer(store, { runDirectory: join(directory, "runtime") });
    const browser = await chromium.launch();
    const requests: Harness["requests"] = [];
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        context.on("request", request =>
            requests.push({ method: request.method(), path: new URL(request.url()).pathname }),
        );
        await page.goto(service.url);
        await enterTicketPlus(page);

        await page.getByRole("button", { name: "編輯活動" }).waitFor();
        await work({ page, browser, url: service.url, store, id: original.id, directory, requests });
        assert.equal(await readFile(klookPath, "utf8"), before);
        assert(!requests.some(request => request.path === "/api/contact"));
        assert(
            !requests.some(
                request =>
                    request.method === "POST" &&
                    ["/api/purchase", "/api/purchase/confirm-login", "/api/purchase/stop"].includes(request.path),
            ),
        );
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
}
async function fillNew(page: Page, name = "新活動") {
    await page.locator("#new").click();
    await page.getByLabel("活動名稱", { exact: true }).fill(name);
    await page.getByLabel("活動網址", { exact: true }).fill("https://ticketplus.com.tw/activity/new-fixture");
    const row = page.getByRole("group", { name: "順位 1", exact: true });
    await row.getByLabel("演出日期").fill("2026-11-22");
    await row.getByLabel("演出時間").fill("18:00");
    await row.getByLabel("票種名稱").fill("A區");
}
async function disk(h: Harness, id: string) {
    return JSON.parse(await readFile(join(h.directory, "events", id + ".json"), "utf8"));
}

test("TicketPlus GUI：真表單重排複製保存與重載，兩平台同名活動隔離", async () => {
    await fixture(async h => {
        const { page } = h;
        assert.equal(await page.locator("#activities tr").count(), 1);
        assert.equal(await page.locator("#brandHome").count(), 1);
        assert.equal(await page.locator("#message").count(), 1);
        await fillNew(page);
        await page.getByRole("button", { name: "新增順位" }).click();
        const second = page.getByRole("group", { name: "順位 2", exact: true });
        await second.getByLabel("演出日期").fill("2026-11-23");
        await second.getByLabel("演出時間").fill("19:00");
        await second.getByLabel("票種名稱").fill("B區");
        await second.getByLabel("張數").fill("2");
        await second.getByRole("button", { name: "複製" }).click();
        const third = page.getByRole("group", { name: "順位 3", exact: true });
        await third.getByLabel("票種名稱").fill("C區");
        await third.getByLabel("張數").fill("3");
        assert.equal(await second.getByLabel("票種名稱").inputValue(), "B區");
        await third.getByRole("button", { name: "上移" }).click();
        await page.getByRole("group", { name: "順位 1", exact: true }).getByRole("button", { name: "移除" }).click();
        await page.getByRole("group", { name: "順位 1", exact: true }).getByRole("button", { name: "下移" }).click();
        assert.equal(await page.getByLabel("最長執行時間（分鐘）").count(), 0);
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        const saved = (await h.store.list()).activities.find(record => record.settings.eventName === "新活動")!;
        assert.deepEqual((await disk(h, saved.id)).settings, {
            platform: "ticketplus",
            eventName: "新活動",
            eventUrl: "https://ticketplus.com.tw/activity/new-fixture",
            targets: [
                { date: "2026-11-23", time: "19:00", ticketType: "B區", quantity: 2 },
                { date: "2026-11-23", time: "19:00", ticketType: "C區", quantity: 3 },
            ],
        });
        await page
            .getByRole("button", { name: "確認與開始", exact: true })
            .getAttribute("aria-current")
            .then(value => assert.equal(value, "step"));
        assert.equal(await page.getByLabel("最長執行時間（分鐘）", { exact: true }).inputValue(), "10");
        await page.locator("#homeButton").click();
        await page
            .locator("#activities tr")
            .filter({ hasText: "新活動" })
            .getByRole("button", { name: "編輯活動" })
            .click();
        assert.equal(
            await page.getByRole("group", { name: "順位 1", exact: true }).getByLabel("票種名稱").inputValue(),
            "B區",
        );
        assert.equal(
            await page.getByRole("group", { name: "順位 2", exact: true }).getByLabel("張數").inputValue(),
            "3",
        );
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.screenshot({ path: "/tmp/ticketplus-settings-desktop.png", fullPage: true });
        await page.setViewportSize({ width: 390, height: 844 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: "/tmp/ticketplus-settings-mobile.png", fullPage: true });
    });
});

test("TicketPlus GUI：活動保存保留原排程與期限，跨場次保存但提示限制", async () => {
    await fixture(async h => {
        const { page } = h;
        await page.getByRole("button", { name: "編輯活動" }).click();
        await page.getByRole("heading", { name: "編輯活動", exact: true }).waitFor();

        // 完整麵包屑保留平台與已保存活動名稱，平台鍵返回列表。
        assert.equal(await page.locator(".breadcrumb-current").innerText(), settings.eventName);
        const crumbs = page.getByRole("navigation", { name: "目前位置" });
        assert.equal(
            await crumbs.getByRole("button", { name: "返回 TicketPlus 活動列表", exact: true }).innerText(),
            "TicketPlus",
        );
        assert.equal(await crumbs.locator('[aria-current="page"]').innerText(), settings.eventName);

        // 步驟分頁沒有編號，目前分頁以 aria-current 標示。
        const tabs = page.getByRole("navigation", { name: "設定步驟" }).getByRole("button");
        assert.deepEqual(await tabs.allInnerTexts(), ["活動與順位", "確認與開始", "執行狀態"]);
        assert.equal(await tabs.nth(0).getAttribute("aria-current"), "step");
        await tabs.nth(1).click();
        assert.equal(await tabs.nth(0).getAttribute("aria-current"), null);
        assert.equal(await tabs.nth(1).getAttribute("aria-current"), "step");
        await tabs.nth(0).click();
        assert.equal(await page.getByRole("note").count(), 0);
        assert.equal(await page.locator("#maxRunMinutes").count(), 0);
        await page.getByRole("button", { name: "複製" }).click();
        await page.getByRole("group", { name: "順位 2", exact: true }).getByLabel("演出日期").fill("2026-11-23");
        await page.getByRole("status").filter({ hasText: "此設定含不同場次" }).waitFor();
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        const saved = (await disk(h, h.id)).settings;
        assert.deepEqual(saved.saleSchedule, { saleAt: "2026-11-01T12:00:00+08:00", advanceSeconds: 2 });
        assert.equal(saved.maxRunMinutes, 10);
        assert.deepEqual(
            saved.targets.map((target: any) => target.date),
            ["2026-11-22", "2026-11-23"],
        );
    });
});

test("TicketPlus GUI：空白新表單與原設定不誤報修改，真正修改離開可取消", async () => {
    await fixture(async ({ page }) => {
        let dialogs = 0;
        page.on("dialog", dialog => {
            dialogs++;
            void dialog.dismiss();
        });

        // 新增按鈕只顯示「＋」，名稱是「新增活動」，滑鼠移上去顯示提示框。
        const add = page.getByRole("button", { name: "新增活動", exact: true });
        const addTip = add.locator(".icon-button-tip");
        assert.equal((await add.innerText()).trim(), "＋");
        assert.equal(await addTip.isVisible(), false);
        await add.hover();
        assert.equal(await addTip.isVisible(), true);
        assert.equal(await addTip.innerText(), "新增活動");
        await page.mouse.move(0, 0);

        await page.locator("#new").click();
        await page.locator("#homeButton").click();
        assert.equal(dialogs, 0);
        await page.getByRole("button", { name: "編輯活動" }).click();
        await page.locator("#homeButton").click();
        assert.equal(dialogs, 0);
        await page.getByRole("button", { name: "編輯活動" }).click();
        await page.locator("#eventName").fill("未保存修改");
        await page.locator("#brandHome").click();
        assert.equal(dialogs, 1);
        assert.equal(await page.locator("#eventName").inputValue(), "未保存修改");
        await page.locator("#homeButton").click();
        assert.equal(dialogs, 2);
        assert.equal(await page.locator("#eventName").inputValue(), "未保存修改");
        page.removeAllListeners("dialog");
        page.once("dialog", dialog => dialog.accept());
        await page.locator("#homeButton").click();
        await page.getByRole("button", { name: "編輯活動" }).click();
        assert.equal(await page.locator("#eventName").inputValue(), "同名活動");

        await page.locator("#homeButton").click();
        assert.equal(await page.getByRole("heading", { name: "活動列表", exact: true }).count(), 1);
        assert.equal(await page.locator("#homeButton").count(), 0);
    });
});

test("TicketPlus GUI：兩分頁真 revision 衝突不覆蓋，失敗保留草稿", async () => {
    await fixture(async h => {
        const { page } = h;
        await page.getByRole("button", { name: "編輯活動" }).click();
        const other = await page.context().newPage();
        await other.goto(h.url);
        await enterTicketPlus(other);

        await other.getByRole("button", { name: "編輯活動" }).click();
        await page.locator("#eventName").fill("A分頁已保存");
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        await other.locator("#eventName").fill("B分頁草稿");
        await other.getByRole("button", { name: "下一步" }).click();
        await other.getByRole("alert").filter({ hasText: "其他分頁修改" }).waitFor();
        assert.equal(
            await other.getByRole("button", { name: "活動與順位", exact: true }).getAttribute("aria-current"),
            "step",
        );
        assert.equal(await other.locator("#eventName").inputValue(), "B分頁草稿");
        assert.equal((await disk(h, h.id)).settings.eventName, "A分頁已保存");
    });
});

test("TicketPlus GUI：保存中連點不重複新增，也不能從首頁按鈕卸載", async () => {
    await fixture(async h => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        let posts = 0;
        await h.page.route("**/api/activities", async route => {
            if (route.request().method() === "POST") {
                posts++;
                entered();
                await gate;
            }
            await route.continue();
        });
        try {
            await fillNew(h.page);
            await h.page.locator("#saveActivity").evaluate((button: HTMLButtonElement) => {
                button.click();
                button.click();
            });
            await started;
            assert(await h.page.locator("#brandHome").isDisabled());
            assert(await h.page.locator("#homeButton").isDisabled());
            for (const tab of await h.page.getByRole("navigation", { name: "設定步驟" }).getByRole("button").all()) {
                assert(await tab.isDisabled());
            }
            assert(await h.page.locator("#eventName").isDisabled());
            release();
            await h.page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
            assert.equal(posts, 1);
            assert.equal(
                (await h.store.list()).activities.filter(record => record.settings.eventName === "新活動").length,
                1,
            );
        } finally {
            release();
        }
    });
});

test("TicketPlus GUI：保存成功但重載失敗仍保留 ID，再編輯以 PUT 保存", async () => {
    await fixture(async h => {
        let saved = false;
        let posts = 0;
        let puts = 0;
        h.page.on("request", request => {
            if (request.method() === "POST" && new URL(request.url()).pathname === "/api/activities") {
                saved = true;
                posts++;
            }
            if (request.method() === "PUT") puts++;
        });
        await h.page.route("**/api/activities", async route => {
            if (route.request().method() === "GET" && saved)
                return route.fulfill({
                    status: 500,
                    contentType: "application/json",
                    body: JSON.stringify({ error: "列表載入失敗" }),
                });
            await route.continue();
        });
        await fillNew(h.page);
        await h.page.getByRole("button", { name: "下一步" }).click();
        await h.page.getByRole("alert").filter({ hasText: "活動已儲存，但列表" }).waitFor();
        assert.equal(
            await h.page.getByRole("button", { name: "確認與開始", exact: true }).getAttribute("aria-current"),
            "step",
        );
        assert.match(await h.page.getByRole("region", { name: "活動摘要" }).innerText(), /新活動/);
        await h.page.getByRole("button", { name: "活動與順位", exact: true }).click();
        await h.page.locator("#eventName").fill("再次編輯");
        await h.page.getByRole("button", { name: "下一步" }).click();
        await h.page.getByRole("alert").filter({ hasText: "活動已儲存，但列表" }).waitFor();
        assert.equal(posts, 1);
        assert.equal(puts, 1);
        assert.equal((await h.store.list()).activities.length, 2);
        assert.equal(
            (await h.store.list()).activities.filter(record => record.settings.eventName === "再次編輯").length,
            1,
        );
    });
});

test("TicketPlus GUI：刪除只刪指定平台活動，取消不送請求", async () => {
    await fixture(async h => {
        h.page.once("dialog", dialog => dialog.dismiss());
        await h.page.getByRole("button", { name: "刪除", exact: true }).click();
        assert(!h.requests.some(request => request.method === "DELETE"));
        h.page.once("dialog", dialog => dialog.accept());
        await h.page.getByRole("button", { name: "刪除", exact: true }).click();
        await eventually(async () => assert.equal(await h.page.locator("#activities tr").count(), 0));
        assert.equal((await h.store.list()).activities.length, 0);
        assert.deepEqual(
            h.requests.filter(request => request.method === "DELETE"),
            [{ method: "DELETE", path: "/api/activities/" + h.id }],
        );
    });
});

test("TicketPlus GUI：列表載入失敗可重新載入，不需切換平台", async () => {
    await fixture(async h => {
        await h.page.route("**/api/activities", route =>
            route.fulfill({
                status: 500,
                json: { error: "LIST_LOAD_ERROR" },
            }),
        );
        await h.page.reload();
        await enterTicketPlus(h.page);
        await h.page.getByRole("alert").filter({ hasText: "LIST_LOAD_ERROR" }).waitFor();
        assert(await h.page.locator("#new").isDisabled());
        await h.page.unroute("**/api/activities");
        await h.page.getByRole("button", { name: "重新載入活動列表" }).click();
        await h.page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        assert(await h.page.locator("#new").isEnabled());
        assert.equal(await h.page.locator("#message").innerText(), "");
    });
});

test("TicketPlus GUI：其他平台的載入回應不能成為編輯資料", async () => {
    await fixture(async h => {
        const original = await h.store.load(h.id);
        await h.page.route("**/api/activities/" + h.id, route =>
            route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...original, settings: klook }) }),
        );
        await h.page.getByRole("button", { name: "編輯活動" }).click();
        await h.page.getByRole("alert").filter({ hasText: "TicketPlus 活動設定格式錯誤" }).waitFor();
        assert.equal(await h.page.locator("#eventName").count(), 0);
        assert.deepEqual((await disk(h, h.id)).settings, settings);
    });
});

test("TicketPlus GUI：未知瀏覽器仍占用時禁止變更，保留查看狀態與後端刪除防護", async () => {
    await fixture(async h => {
        const lease = acquirePurchaseLease(join(h.directory, "runtime"));
        try {
            const occupied = {
                id: "occupied-external",
                requestId: "fixture",
                platform: null,
                activityName: "占用活動",
                status: "failed",
                occupied: true,
                browserOpen: true,
                events: [],
                historyTruncated: false,
                canCloseBrowser: false,
            };
            await snapshotFeed(h.page, "/api/purchase/events", occupied);
            await h.page.reload();
            await enterTicketPlus(h.page);

            await eventually(async () => assert(await h.page.locator("#new").isDisabled()));
            // 列表頁也用麵包屑的鎖定標籤說明，不再顯示整行說明文字。
            assert.match(await h.page.locator(".breadcrumb .lock-chip").innerText(), /^🔒 設定已鎖定/);
            assert.equal(await h.page.locator("p", { hasText: "暫時無法變更活動設定" }).count(), 0);
            assert(await h.page.getByRole("button", { name: "編輯活動" }).isDisabled());
            assert(await h.page.getByRole("button", { name: "刪除", exact: true }).isDisabled());
            assert(await h.page.locator("#new").isDisabled());
            await h.page.getByRole("button", { name: "查看目前狀態" }).click();
            await h.page.locator("#logs").filter({ hasText: "購票平台：未知" }).waitFor();
            const token = await h.page.locator('meta[name="local-token"]').getAttribute("content");
            const response = await fetch(h.url + "/api/activities/" + h.id, {
                method: "DELETE",
                headers: { "X-Local-Token": token!, Origin: h.url },
            });
            assert.equal(response.status, 400);
            assert.deepEqual((await disk(h, h.id)).settings, settings);
        } finally {
            releasePurchaseLease(lease);
        }
    });
});

test("TicketPlus GUI：最後一列清空仍保留一列，不保存不完整設定", async () => {
    await fixture(async h => {
        await h.page.getByRole("button", { name: "編輯活動" }).click();
        await h.page.getByRole("button", { name: "清空", exact: true }).click();
        assert.equal(await h.page.getByRole("group", { name: /^順位 / }).count(), 1);
        assert.equal(await h.page.getByLabel("票種名稱").inputValue(), "");
        assert.equal(await h.page.getByLabel("張數", { exact: true }).inputValue(), "1");
        await h.page.getByRole("button", { name: "下一步" }).click();
        assert(!h.requests.some(request => request.method === "PUT" || request.method === "POST"));
        assert.deepEqual((await disk(h, h.id)).settings, settings);
    });
});

test("TicketPlus GUI：儲存成功訊息保留無法載入設定檔的警告", async () => {
    await fixture(async h => {
        await writeFile(join(h.directory, "events", "broken.json"), "{invalid");
        await fillNew(h.page);
        await h.page.getByRole("button", { name: "下一步" }).click();
        await h.page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        assert.match(await h.page.getByRole("alert").innerText(), /1 個設定檔無法載入，未覆寫/);
        assert.equal(await readFile(join(h.directory, "events", "broken.json"), "utf8"), "{invalid");
    });
});

test("TicketPlus GUI：活動網址下方設定購票流程，抽選才寫入設定，列表不顯示流程", async () => {
    await fixture(async h => {
        const { page } = h;
        await fillNew(page, "抽選活動");

        // 單選框位於活動網址正下方，預設購票
        const group = page.getByRole("group", { name: "購票流程" });
        const urlField = page.getByLabel("活動網址", { exact: true });
        const fieldset = page.locator("fieldset.feature-settings");
        assert.equal(await fieldset.count(), 1);
        assert.equal(
            await urlField.evaluate(input =>
                input.closest("label")?.nextElementSibling?.matches("fieldset.feature-settings"),
            ),
            true,
        );
        assert.equal(await page.locator("#flowPurchase").isChecked(), true);
        assert.equal(await page.locator("#flowLottery").isChecked(), false);
        assert.equal(await group.locator('label.check input[type="radio"][name="flowType"]').count(), 2);

        // 選抽選後另一個取消，存檔寫入 lottery
        await group.getByLabel("登記抽選").check();
        assert.equal(await page.locator("#flowPurchase").isChecked(), false);
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        const saved = (await h.store.list()).activities.find(record => record.settings.eventName === "抽選活動")!;
        assert.equal((await disk(h, saved.id)).settings.flowType, "lottery");

        // 列表只呈現名稱、執行狀態與操作，流程仍保存在活動設定。
        await page.locator("#homeButton").click();
        const lotteryRow = page.locator("#activities tr").filter({ hasText: "抽選活動" });
        await lotteryRow.waitFor();
        assert.deepEqual(await page.getByRole("columnheader").allTextContents(), ["活動名稱", "執行狀態", "操作"]);
        assert.equal(await lotteryRow.getByRole("cell").count(), 3);
        assert.equal(await page.locator("#activities").getByText("登記抽選", { exact: true }).count(), 0);
        assert.equal(await page.locator("#activities").getByText("購票", { exact: true }).count(), 0);

        // 舊活動改名後以購票重新存檔，設定檔不寫流程類型
        await page
            .locator("#activities tr")
            .filter({ hasText: "同名活動" })
            .getByRole("button", { name: "編輯活動" })
            .click();
        assert.equal(await page.locator("#flowPurchase").isChecked(), true);
        await page.getByLabel("活動名稱", { exact: true }).fill("同名活動改名");
        await page.getByRole("button", { name: "下一步" }).click();
        await page.getByRole("alert").filter({ hasText: "活動已儲存" }).waitFor();
        const resaved = (await disk(h, h.id)).settings;
        assert.equal(resaved.eventName, "同名活動改名");
        assert.equal("flowType" in resaved, false);
    });
});

test("TicketPlus 列表：初次載入期間不誤報空資料，成功空回應才顯示尚未儲存", async () => {
    await fixture(async h => {
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let reads = 0;
        await h.page.route("**/api/activities", async route => {
            reads++;
            await gate;
            await route.fulfill({ json: { activities: [], invalidFiles: 0 } });
        });
        try {
            await h.page.reload();
            await enterTicketPlus(h.page);
            await eventually(async () => assert(reads > 0));
            assert(await h.page.locator("#activityListLoading").isVisible());
            assert(!(await h.page.locator("#emptyActivities").isVisible()));
            assert(await h.page.locator("#new").isDisabled());
            assert.equal(await h.page.getByRole("button", { name: "重新載入活動列表" }).count(), 0);
        } finally {
            release();
        }
        await h.page.locator("#emptyActivities").waitFor();
        assert(!(await h.page.locator("#activityListLoading").isVisible()));
        assert(await h.page.locator("#new").isEnabled());
    });
});

test("TicketPlus 列表：失敗才提供重試，等待回應時連點不重送，成功後移除按鈕", async () => {
    await fixture(async h => {
        await h.page.route("**/api/activities", route =>
            route.fulfill({ status: 500, json: { error: "INITIAL_LIST_FAILURE" } }),
        );
        await h.page.reload();
        await enterTicketPlus(h.page);
        await h.page.locator("#activityListError").filter({ hasText: "INITIAL_LIST_FAILURE" }).waitFor();
        assert(!(await h.page.locator("#emptyActivities").isVisible()));
        let reads = 0;
        let release = () => {};
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await h.page.unroute("**/api/activities");
        await h.page.route("**/api/activities", async route => {
            reads++;
            await gate;
            await route.continue();
        });
        const retry = h.page.getByRole("button", { name: "重新載入活動列表", exact: true });
        try {
            // 同一個瀏覽器工作內連點，驗證事件處理器的防重送，不依賴 React 已重繪。
            await retry.evaluate(element => {
                if (!(element instanceof HTMLButtonElement)) throw new Error("重試入口不是按鈕");
                element.click();
                element.click();
            });
            await eventually(async () => assert.equal(reads, 1));
            assert(await retry.isDisabled());
            assert(await h.page.locator("#activityListLoading").isVisible());
        } finally {
            release();
        }
        await h.page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        assert.equal(reads, 1);
        assert.equal(await retry.count(), 0);
        assert(!(await h.page.locator("#activityListError").isVisible()));
    });
});

const listRefreshRun = {
    id: "list-refresh-run",
    requestId: "list-refresh-request",
    platform: "ticketplus",
    activityName: "列表刷新測試",
    status: "failed",
    occupied: false,
    browserOpen: false,
    canCloseBrowser: false,
    events: [],
    historyTruncated: false,
};

test("TicketPlus 列表：背景刷新失敗保留活動，狀態連線提示不覆蓋列表錯誤", async () => {
    await fixture(async h => {
        const feed = await snapshotFeed(h.page, "/api/purchase/events", null);
        await h.page.reload();
        await enterTicketPlus(h.page);
        await h.page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
        await h.page.screenshot({ path: "/tmp/ticket-activity-list-normal.png", fullPage: true });
        await h.page.route("**/api/activities", route =>
            route.fulfill({ status: 500, json: { error: "BACKGROUND_LIST_FAILURE" } }),
        );
        feed.publish(listRefreshRun);
        await h.page.locator("#activityListError").filter({ hasText: "BACKGROUND_LIST_FAILURE" }).waitFor();
        assert.equal(await h.page.locator("#activities tr").count(), 1);
        assert((await h.page.locator("#activities").innerText()).includes(settings.eventName));
        assert(!(await h.page.locator("#emptyActivities").isVisible()));
        // 短 SSE 結束會顯示重連訊息；這個全域訊息不能清除列表自己的錯誤。
        await h.page.locator("#message").filter({ hasText: "狀態連線中斷" }).waitFor();
        assert.match(await h.page.locator("#activityListError").innerText(), /BACKGROUND_LIST_FAILURE/);
        assert(await h.page.getByRole("button", { name: "重新載入活動列表" }).isVisible());
        assert.match(await h.page.locator("#activityListError").innerText(), /保留上次載入/);
        await h.page.screenshot({ path: "/tmp/ticket-activity-list-error.png", fullPage: true });
    });
});

for (const oldOutcome of ["success", "failure"] as const) {
    test(`TicketPlus 列表：過期 ${oldOutcome} 回應不覆蓋最新列表或載入狀態`, async () => {
        await fixture(async h => {
            const feed = await snapshotFeed(h.page, "/api/purchase/events", null);
            await h.page.reload();
            await enterTicketPlus(h.page);
            await h.page.getByRole("button", { name: "編輯活動", exact: true }).waitFor();
            const saved = await h.store.load(h.id);
            let release = () => {};
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            let reads = 0;
            await h.page.route("**/api/activities", async route => {
                reads++;
                if (reads === 1) {
                    await gate;
                    if (oldOutcome === "failure") {
                        await route.fulfill({ status: 500, json: { error: "STALE_LIST_FAILURE" } });
                    } else {
                        await route.fulfill({ json: { activities: [], invalidFiles: 0 } });
                    }
                    return;
                }
                await route.fulfill({
                    json: {
                        activities: [
                            {
                                ...saved,
                                settings: { ...saved.settings, eventName: "最新活動" },
                                executionStatus: "已執行",
                            },
                        ],
                        invalidFiles: 0,
                    },
                });
            });
            try {
                feed.publish(listRefreshRun);
                await eventually(async () => assert.equal(reads, 1));
                assert(await h.page.locator("#activityListLoading").isVisible());
                feed.publish({ ...listRefreshRun, status: "unknown" });
                await h.page.locator("#activities").filter({ hasText: "最新活動" }).waitFor();
                assert(!(await h.page.locator("#activityListLoading").isVisible()));
                const oldResponse = h.page.waitForResponse(
                    response =>
                        new URL(response.url()).pathname === "/api/activities" &&
                        (oldOutcome === "failure" ? response.status() === 500 : response.status() === 200),
                );
                release();
                await oldResponse;
                await h.page.evaluate(
                    () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
                );
                assert.match(await h.page.locator("#activities").innerText(), /最新活動/);
                assert(!(await h.page.locator("#activityListError").isVisible()));
                assert(!(await h.page.locator("#activityListLoading").isVisible()));
                assert(!(await h.page.locator("#emptyActivities").isVisible()));
                assert.equal(await h.page.getByRole("button", { name: "重新載入活動列表" }).count(), 0);
            } finally {
                release();
            }
        });
    });
}

test("TicketPlus 列表：刪除成功但列表重新載入失敗，移除該列並提示重試，不重送刪除", async () => {
    await fixture(async h => {
        let deleted = false;
        await h.page.route("**/api/activities", route => {
            if (route.request().method() === "GET" && deleted) {
                return route.fulfill({ status: 500, json: { error: "RELOAD_AFTER_DELETE_FAILURE" } });
            }
            return route.continue();
        });
        h.page.on("request", request => {
            if (request.method() === "DELETE") deleted = true;
        });
        h.page.once("dialog", dialog => dialog.accept());
        await h.page.getByRole("button", { name: "刪除", exact: true }).click();

        await h.page.locator("#message").filter({ hasText: "活動已刪除，但列表重新載入失敗" }).waitFor();
        await h.page.locator("#activityListError").filter({ hasText: "RELOAD_AFTER_DELETE_FAILURE" }).waitFor();
        assert.equal(await h.page.locator("#activities tr").count(), 0);
        assert.equal((await h.store.list()).activities.length, 0);
        assert.equal(h.requests.filter(request => request.method === "DELETE").length, 1);
    });
});
