import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium, type Page } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { saveContactDetails } from "../src/config/contact.config.js";
import { startLocalServer } from "../src/local/server.js";
const settings = {
    eventName: "Fixture",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false }],
};
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "fixture@example.com",
};
async function fixture(action: (page: Page, store: ActivityStore, id: string, url: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "ticket-four-"));
    const store = new ActivityStore(join(dir, "events"));
    const record = await store.save(settings);
    await saveContactDetails(contact, join(dir, "contact.json"));
    const service = await startLocalServer(store, {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
        purchaseWorker: new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.goto(service.url);
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await action(page, store, record.id, service.url);
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
}
function result(id: string) {
    return {
        id,
        activityName: "Fixture",
        status: "payment-ready",
        occupied: false,
        browserOpen: false,
        message: "fixture",
        events: [],
        historyTruncated: false,
    };
}

test("四步：時間草稿、延遲保存鎖定、一次啟動與run隔離", async () =>
    fixture(async (page, store, id) => {
        await page.locator("#mode").selectOption("scheduled");
        await page.locator("#saleAt").fill("2027-01-01T10:00");
        await page.locator("#confirm").check();
        await page.locator("#advance").selectOption("2");
        assert(!(await page.locator("#confirm").isChecked()));
        assert.doesNotMatch(await page.locator("#summary").innerText(), /立即開始|開賣：/);
        assert.equal(await page.locator("#saleAt").inputValue(), "2027-01-01T10:00");
        assert.equal(await page.locator("#advance").inputValue(), "2");
        assert.equal((await store.load(id)).settings.saleSchedule, undefined);
        await page.screenshot({ path: "/tmp/ticket-four-confirm.png", fullPage: true });
        let release: () => void = () => {};
        let saving: () => void = () => {};
        const gate = new Promise<void>(resolve => (release = resolve));
        const received = new Promise<void>(resolve => (saving = resolve));
        await page.route("**/api/activities/*", async route => {
            if (route.request().method() === "PUT") {
                saving();
                await gate;
            }
            await route.continue();
        });
        const starts: any[] = [];
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            starts.push(route.request().postDataJSON());
            await route.fulfill({ json: result("new-run") });
        });
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await received;
        assert(await page.locator("#saleAt").isDisabled());
        assert(await page.locator("#phone").isDisabled());
        assert(await page.locator("#homeButton").isDisabled());
        assert.equal(starts.length, 0);
        release();
        await page.locator("#step4").waitFor();
        assert.equal(starts.length, 1);
        await page.screenshot({ path: "/tmp/ticket-four-status.png", fullPage: true });
        assert.deepEqual(starts[0].expectedActivity, (await store.load(id)).settings);
        await page.evaluate("render({id:'old',status:'failed',occupied:false,events:[],activityName:'Old'})");
        assert.match(await page.locator("#logs").innerText(), /Fixture/);
        await page.locator("#homeButton").click();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        await page.getByRole("button", { name: "④ 執行狀態" }).click();
        assert.equal(await page.locator("#status").innerText(), "尚未執行");
        await page.evaluate("render({id:'old',status:'failed',occupied:false,events:[],activityName:'Old'})");
        assert.equal(await page.locator("#status").innerText(), "尚未執行");
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#mode").selectOption("now");
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#step4").waitFor();
        assert.equal(starts.length, 2);
        assert.equal(starts[1].expectedActivity.saleSchedule, undefined);
        assert.equal((await store.load(id)).settings.saleSchedule, undefined);
    }));

test("四步：保存拒絕留第三步；未知請求不能改時間再保存", async () =>
    fixture(async (page, store, id) => {
        await page.locator("#mode").selectOption("scheduled");
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: "請填寫開賣時間" }).waitFor();
        assert(await page.locator("#step3").isVisible());
        await page.locator("#saleAt").fill("2027-01-01T10:00");
        let puts = 0,
            starts = 0;
        await page.route("**/api/activities/*", async route => {
            if (route.request().method() === "PUT") puts++;
            await route.continue();
        });
        await page.route("**/api/purchase", async route => {
            if (route.request().method() !== "POST") return route.continue();
            starts++;
            await route.abort();
        });
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.waitForFunction(() => document.querySelector("#message")!.textContent!.length > 0);
        assert(await page.locator("#step3").isVisible());
        const pending = await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request"));
        assert(pending);
        await page.locator("#saleAt").fill("2027-01-01T11:00");
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: "上一筆開始請求結果尚待確認" }).waitFor();
        assert.equal(puts, 1);
        assert.equal(starts, 1);
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), pending);
        assert.match((await store.load(id)).settings.saleSchedule!.saleAt, /10:00/);
    }));

test("四步：聯絡資料不依賴未完成時間，跨分頁版本不同不覆寫或啟動", async () =>
    fixture(async (page, store, id) => {
        await page.locator("#mode").selectOption("scheduled");
        await page.getByRole("button", { name: "② 聯絡資料" }).click();
        await page.locator("#saveContact").click();
        await page.locator("#step3").waitFor();
        await page.locator("#saleAt").fill("2027-01-01T10:00");
        await store.save({ ...settings, eventName: "Updated elsewhere" }, id);
        let starts = 0;
        await page.route("**/api/purchase", async route => {
            if (route.request().method() === "POST") starts++;
            await route.fulfill({ status: 400, json: { error: "unexpected" } });
        });
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#message").filter({ hasText: "其他分頁修改" }).waitFor();
        assert.equal(starts, 0);
        assert.equal((await store.load(id)).settings.eventName, "Updated elsewhere");
        assert(await page.locator("#step3").isVisible());
    }));

test("順位清空：保留空列、阻擋舊設定啟動，重新填寫才能保存", async () =>
    fixture(async (page, store, id) => {
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isEnabled());
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#add").click();
        assert.equal(await page.getByRole("button", { name: "移除", exact: true }).count(), 2);
        await page.locator(".target-row").last().getByRole("button", { name: "移除", exact: true }).click();
        assert.equal(await page.locator("[name=area]").inputValue(), "B區");
        assert.equal(await page.locator(".position").innerText(), "順位 1");
        await page.locator("[name=quantity]").fill("2");
        await page.locator("[name=adjacent]").check();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.getByRole("button", { name: "清空", exact: true }).click();
        assert.equal(await page.locator(".target-row").count(), 1);
        for (const name of ["date", "time", "area", "unitPrice"]) {
            assert.equal(await page.locator(`[name=${name}]`).inputValue(), "");
        }
        assert.equal(await page.locator("[name=quantity]").inputValue(), "1");
        assert(!(await page.locator("[name=adjacent]").isChecked()));
        assert(await page.locator("[name=adjacent]").isDisabled());
        assert(!(await page.locator("#confirm").isChecked()));
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isDisabled());
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#saveActivity").click();
        await page.locator("#message").filter({ hasText: "活動設定格式錯誤" }).waitFor();
        assert(await page.locator("#step1").isVisible());
        assert.deepEqual((await store.load(id)).settings.targets, settings.targets);
        page.once("dialog", dialog => dialog.dismiss());
        await page.locator("#homeButton").click();
        assert(await page.locator("#step1").isVisible());
        assert.equal(await page.locator("[name=area]").inputValue(), "");
        await page.locator("[name=date]").fill("2026-11-03");
        await page.locator("[name=time]").fill("18:00");
        await page.locator("[name=area]").fill("C區");
        await page.locator("[name=unitPrice]").fill("4880");
        await page.locator("[name=quantity]").fill("2");
        await page.locator("[name=adjacent]").check();
        let release: () => void = () => {};
        let received: () => void = () => {};
        const gate = new Promise<void>(resolve => (release = resolve));
        const saving = new Promise<void>(resolve => (received = resolve));
        await page.route("**/api/activities/*", async route => {
            if (route.request().method() === "PUT") {
                received();
                await gate;
            }
            await route.continue();
        });
        await page.locator("#saveActivity").click();
        await saving;
        try {
            assert(await page.getByRole("button", { name: "清空", exact: true }).isDisabled());
            assert(await page.locator("#add").isDisabled());
        } finally {
            release();
        }
        await page.locator("#step2").waitFor();
        assert.deepEqual((await store.load(id)).settings.targets, [
            { date: "2026-11-03", time: "18:00", area: "C區", unitPrice: 4880, quantity: 2, adjacent: true },
        ]);
    }));

test("摘要：欄位表格、完整連結、空白草稿及窄螢幕", async () =>
    fixture(async page => {
        assert.deepEqual(await page.locator("#summary th").allTextContents(), [
            "順位",
            "演出日期",
            "時間",
            "票區／票種",
            "單張價格",
            "張數",
            "合計",
            "要求連位",
        ]);
        assert.match(await page.locator("#summary tbody").innerText(), /NT\$5,280/);
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        const url = settings.eventUrl + "?spm=" + "long-tracking-value".repeat(30);
        const name = '<img src=x onerror="alert(1)">長活動名稱'.repeat(5);
        await page.locator("#eventUrl").fill(url);
        await page.locator("#eventName").fill(name);
        await page.locator("#add").click();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        const link = page.locator("#summary a");
        assert.equal(await link.getAttribute("href"), url);
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
        assert.equal(await page.locator("#summary img").count(), 0);
        assert((await page.locator("#summary").innerText()).includes(name));
        assert.equal(await page.locator("#summary tbody tr").count(), 2);
        const empty = page.locator("#summary tbody tr").last();
        assert.match(await empty.innerText(), /未填寫/);
        assert.equal(await empty.locator("td").nth(6).innerText(), "—");
        assert(await page.locator("#start").isDisabled());
        await page.setViewportSize({ width: 390, height: 844 });
        assert(
            await link.evaluate(
                el => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow === "ellipsis",
            ),
        );
        const summaryBox = await page.locator("#summary").boundingBox();
        assert(summaryBox && summaryBox.x + summaryBox.width <= 390);
        const scroll = page.locator(".summary-table-scroll");
        assert(
            await scroll.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === "auto"),
        );
        await page.screenshot({ path: "/tmp/ticket-summary-mobile.png", fullPage: true });
        await page.setViewportSize({ width: 1280, height: 1000 });
        await page.screenshot({ path: "/tmp/ticket-summary-desktop.png", fullPage: true });
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#eventUrl").fill("javascript:alert(1)");
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        assert.equal(await page.locator("#summary a").count(), 0);
        assert.match(await page.locator("#summary").innerText(), /javascript:alert\(1\)/);
    }));
