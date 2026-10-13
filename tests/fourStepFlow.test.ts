import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";
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
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-02", time: "19:30", area: "B區", quantity: 1, adjacent: false }],
};
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "fixture@example.com",
};
async function fixture(
    action: (
        page: Page,
        store: ActivityStore,
        id: string,
        url: string,
        feed: Awaited<ReturnType<typeof snapshotFeed>> | null,
    ) => Promise<void>,
    controlledFeed = false,
) {
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
        const feed = controlledFeed ? await snapshotFeed(page, "/api/purchase/events") : null;
        await page.goto(service.url);
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await action(page, store, record.id, service.url, feed);
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
    fixture(async (page, store, id, _url, controlled) => {
        const feed = controlled!;
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
        assert.deepEqual(starts[0].expectedActivity.saleSchedule, {
            saleAt: "2027-01-01T10:00:00+08:00",
            advanceSeconds: 2,
        });
        feed.publish({ ...result("old"), status: "failed", occupied: true });
        await eventually(async () => assert.match((await page.locator("#homeRun").textContent()) ?? "", /仍占用中/));
        assert.match(await page.locator("#logs").innerText(), /Fixture/);
        feed.publish({ ...result("old"), status: "failed", occupied: false });
        await eventually(async () => assert.equal(await page.locator("#homeRun").textContent(), ""));
        await page.locator("#homeButton").click();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        await page.getByRole("button", { name: "④ 執行狀態" }).click();
        assert.equal(await page.locator("#status").innerText(), "尚未執行");
        feed.publish({ ...result("old"), status: "failed", occupied: true });
        await eventually(async () => assert.match((await page.locator("#homeRun").textContent()) ?? "", /仍占用中/));
        assert.equal(await page.locator("#status").innerText(), "尚未執行");
        feed.publish({ ...result("old"), occupied: false });
        await eventually(async () => assert.equal(await page.locator("#homeRun").textContent(), ""));
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#mode").selectOption("now");
        await page.locator("#confirm").check();
        await page.locator("#start").click();
        await page.locator("#step4").waitFor();
        assert.equal(starts.length, 2);
        assert.equal(starts[1].expectedActivity.saleSchedule, undefined);
        assert.equal((await store.load(id)).settings.saleSchedule, undefined);
    }, true));

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
        for (const name of ["date", "time", "area"]) {
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
            assert(await page.getByRole("button", { name: "複製", exact: true }).isDisabled());
            assert(await page.locator("#add").isDisabled());
        } finally {
            release();
        }
        await page.locator("#step2").waitFor();
        assert.deepEqual((await store.load(id)).settings.targets, [
            { date: "2026-11-03", time: "18:00", area: "C區", quantity: 2, adjacent: true },
        ]);
    }));

test("摘要：欄位表格、完整連結、空白草稿及窄螢幕", async () =>
    fixture(async page => {
        assert.deepEqual(await page.locator("#summary th").allTextContents(), [
            "順位",
            "演出日期",
            "時間",
            "票區／票種",
            "張數",
            "要求連位",
        ]);
        assert.match(await page.locator("#summary tbody").innerText(), /B區/);
        assert.doesNotMatch(await page.locator("#summary").innerText(), /單張價格|合計|NT\$/);
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
        assert.equal(await empty.locator("td").nth(4).innerText(), "1");
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

for (const version of [undefined, 2, 3]) {
    test(`舊版未決請求 ${version ?? "無版本"} 不因平台升版而清除或重送`, async () =>
        fixture(async (page, _store, id) => {
            let starts = 0;
            let saves = 0;
            page.on("request", request => {
                if (request.method() === "PUT") saves++;
                if (request.method() === "POST" && new URL(request.url()).pathname === "/api/purchase") starts++;
            });
            const pending = JSON.stringify({
                ...(version === undefined ? {} : { version }),
                requestId: "11111111-1111-4111-8111-111111111111",
                activityId: id,
                signature: "old-price-hash",
            });
            await page.evaluate(value => sessionStorage.setItem("ticketpilot-purchase-request", value), pending);
            await page.locator("#confirm").check();
            await page.locator("#start").click();
            await page.locator("#message").filter({ hasText: "舊版開始請求結果尚待確認" }).waitFor();
            assert.equal(starts, 0);
            assert.equal(saves, 0);
            assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), pending);
            await page.reload();
            assert.equal(await page.evaluate(() => sessionStorage.getItem("ticketpilot-purchase-request")), pending);
        }));
}

test("順位複製：插入來源下方、保留草稿且獨立編輯，儲存後順序不變", async () =>
    fixture(async (page, store, id) => {
        // 建立尾列並修改來源，確認複製使用尚未儲存的內容
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#add").click();
        const rows = page.locator(".target-row");
        const source = rows.nth(0);
        await rows.nth(1).locator("[name=area]").fill("尾列");
        await source.locator("[name=date]").fill("2026-11-21");
        await source.locator("[name=time]").fill("14:00");
        await source.locator("[name=area]").fill("黃2C");
        await source.locator("[name=quantity]").fill("2");
        await source.locator("[name=adjacent]").check();
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await source.getByRole("button", { name: "複製", exact: true }).click();

        // 核對每個欄位與插入位置，不沿用舊確認
        assert.equal(await rows.count(), 3);
        assert.deepEqual(await page.locator(".position").allTextContents(), ["順位 1", "順位 2", "順位 3"]);
        const copy = rows.nth(1);
        for (const [name, value] of Object.entries({
            date: "2026-11-21",
            time: "14:00",
            area: "黃2C",
            quantity: "2",
        })) {
            assert.equal(await copy.locator(`[name=${name}]`).inputValue(), value);
        }
        assert(await copy.locator("[name=adjacent]").isChecked());
        assert(await copy.locator("[name=adjacent]").isEnabled());
        assert.equal(await rows.nth(2).locator("[name=area]").inputValue(), "尾列");
        assert(!(await page.locator("#confirm").isChecked()));
        assert.deepEqual((await store.load(id)).settings.targets, settings.targets);

        // 修改副本並排序，確認新列的事件可用且不影響來源
        await copy.locator("[name=area]").fill("黃2D");
        await copy.locator("[name=quantity]").fill("1");
        assert(await copy.locator("[name=adjacent]").isDisabled());
        assert(!(await copy.locator("[name=adjacent]").isChecked()));
        assert.equal(await source.locator("[name=quantity]").inputValue(), "2");
        assert(await source.locator("[name=adjacent]").isChecked());
        await copy.getByRole("button", { name: "上移", exact: true }).click();
        assert.equal(await rows.nth(0).locator("[name=area]").inputValue(), "黃2D");
        await rows.nth(0).getByRole("button", { name: "下移", exact: true }).click();
        await rows.nth(2).getByRole("button", { name: "移除", exact: true }).click();

        // 儲存並重新載入，確認順位和資料持久化
        await page.locator("#saveActivity").click();
        await page.locator("#step2").waitFor();
        const expected = [
            { date: "2026-11-21", time: "14:00", area: "黃2C", quantity: 2, adjacent: true },
            { date: "2026-11-21", time: "14:00", area: "黃2D", quantity: 1, adjacent: false },
        ];
        assert.deepEqual((await store.load(id)).settings.targets, expected);
        await page.reload();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        assert.deepEqual(
            await page
                .locator("[name=area]")
                .evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)),
            ["黃2C", "黃2D"],
        );
    }));

test("順位複製：空白草稿保持空白，單張連位限制與副本刪除正常", async () =>
    fixture(async page => {
        // 複製唯一順位，沿用單張票的連位限制
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.getByRole("button", { name: "複製", exact: true }).click();
        const rows = page.locator(".target-row");
        assert.equal(await rows.count(), 2);
        assert(await rows.nth(1).locator("[name=adjacent]").isDisabled());
        await rows.nth(1).getByRole("button", { name: "移除", exact: true }).click();
        await page.getByRole("button", { name: "清空", exact: true }).click();

        // 數字空白不可在複製時被轉成零或預設值
        await rows.nth(0).locator("[name=quantity]").fill("");
        await page.getByRole("button", { name: "複製", exact: true }).click();
        for (const name of ["date", "time", "area", "quantity"]) {
            assert.equal(await rows.nth(1).locator(`[name=${name}]`).inputValue(), "");
        }
        assert(!(await rows.nth(1).locator("[name=adjacent]").isChecked()));
        assert(await rows.nth(1).locator("[name=adjacent]").isDisabled());
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isDisabled());
    }));

test("套票GUI：啟用、複製、摘要、儲存重載及關閉後移除殘值", async () =>
    fixture(async (page, store, id) => {
        // 舊活動預設關閉，啟用後要求每列填寫
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        assert(!(await page.locator("#bundleEnabled").isChecked()));
        assert(await page.locator("#deliveryMethod").isDisabled());
        assert(!(await page.locator("[name=bundle]").isVisible()));
        await page.locator("#bundleEnabled").check();
        await page.locator("#saveActivity").click();
        await page.locator("#message").filter({ hasText: "每個順位" }).waitFor();
        assert(await page.locator("#deliveryMethod").isEnabled());
        await page.locator("[name=bundle]").fill("演唱會套票 1");
        await page.locator("#deliveryMethod").fill("指定地點自取");
        await page.getByRole("button", { name: "複製", exact: true }).click();
        assert.equal(await page.locator("[name=bundle]").nth(1).inputValue(), "演唱會套票 1");
        await page.locator("[name=bundle]").nth(1).fill("演唱會套票 2");

        // 儲存摘要與重載都保留新條件
        await page.locator("#saveActivity").click();
        await page.locator("#step2").waitFor();
        const saved = (await store.load(id)).settings;
        assert.equal(saved.bundleEnabled, true);
        assert.equal(saved.deliveryMethod, "指定地點自取");
        assert.deepEqual(
            saved.targets.map(t => t.bundle),
            ["演唱會套票 1", "演唱會套票 2"],
        );
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        assert.match(await page.locator("#summary").innerText(), /指定地點自取/);
        assert.match(await page.locator("#summary").innerText(), /演唱會套票 2/);
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isEnabled());
        await page.reload();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        assert(await page.locator("#bundleEnabled").isChecked());
        assert(await page.locator("#deliveryMethod").isEnabled());
        assert.equal(await page.locator("[name=bundle]").nth(1).inputValue(), "演唱會套票 2");

        // 關閉套票清除取票方式，重新開啟不得帶回舊值
        await page.locator("#bundleEnabled").uncheck();
        assert(await page.locator("#deliveryMethod").isDisabled());
        assert.equal(await page.locator("#deliveryMethod").inputValue(), "");
        await page.locator("#saveActivity").click();
        await page.locator("#step2").waitFor();
        const disabled = (await store.load(id)).settings;
        assert.equal(disabled.bundleEnabled, undefined);
        assert(disabled.targets.every(t => t.bundle === undefined));
        assert.equal(disabled.deliveryMethod, undefined);
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#bundleEnabled").check();
        assert.equal(await page.locator("[name=bundle]").nth(0).inputValue(), "");
    }));

test("套票設定獨立區塊：舊取票值保留且阻擋儲存與啟動，明確清除才更新", async () =>
    fixture(async (page, store, id) => {
        // 載入舊版獨立取票設定，不能默默清除或自動啟用套票
        await store.save({ ...settings, deliveryMethod: "指定地點自取" }, id);
        await page.reload();
        await page.locator("#activities").getByText("使用活動").click();
        await page.locator("#step1").waitFor();
        assert.equal(await page.locator("#bundleSettings h2").count(), 0);
        assert(await page.getByRole("checkbox", { name: "組合套票", exact: true }).isVisible());
        assert(await page.getByRole("checkbox", { name: "排隊流程", exact: true }).isVisible());
        assert.equal(await page.getByText("套票或取票方式無法選取時會停止", { exact: false }).count(), 0);
        assert(
            await page.getByRole("group", { name: "功能啟用" }).getByRole("checkbox", { name: "組合套票" }).isVisible(),
        );
        assert(!(await page.locator("#bundleEnabled").isChecked()));
        assert(await page.locator("#deliveryMethod").isDisabled());
        assert.equal(await page.locator("#deliveryMethod").inputValue(), "指定地點自取");
        assert(await page.locator("#legacyDelivery").isVisible());
        await page.locator("#saveActivity").click();
        await page.locator("#message").filter({ hasText: "舊取票方式" }).waitFor();
        assert(await page.locator("#deliveryMethod").isDisabled());
        assert.equal((await store.load(id)).settings.deliveryMethod, "指定地點自取");
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        await page.locator("#confirm").check();
        assert(await page.locator("#start").isDisabled());

        // 清除是明確編輯，儲存前不改原檔且取消先前確認
        await page.getByRole("button", { name: "① 活動與順位" }).click();
        await page.locator("#clearLegacyDelivery").click();
        assert(!(await page.locator("#confirm").isChecked()));
        assert(!(await page.locator("#legacyDelivery").isVisible()));
        assert.equal((await store.load(id)).settings.deliveryMethod, "指定地點自取");
        await page.locator("#saveActivity").click();
        await page.locator("#step2").waitFor();
        assert.equal((await store.load(id)).settings.deliveryMethod, undefined);
        await page.getByRole("button", { name: "③ 確認與開始" }).click();
        assert.doesNotMatch(await page.locator("#summary").innerText(), /指定地點自取/);
    }));

test("跨活動切換重新計算取票欄位狀態，儲存失敗後仍可依開關編輯", async () =>
    fixture(async (page, store, id) => {
        // 同一頁切換啟用與未啟用活動，操作鎖不能還原錯誤狀態
        const bundle = await store.save({
            ...settings,
            eventName: "套票活動",
            bundleEnabled: true,
            deliveryMethod: "郵寄",
            targets: settings.targets.map(t => ({ ...t, bundle: "套票1" })),
        });
        await page.reload();
        const use = async (name: string) => {
            await page.locator("#activities tr").filter({ hasText: name }).getByText("使用活動").click();
            await page.locator("#step1").waitFor();
        };
        await use("套票活動");
        assert(await page.locator("#deliveryMethod").isEnabled());
        assert.equal(await page.locator("#deliveryMethod").inputValue(), "郵寄");
        await page.locator("#homeButton").click();
        await use("Fixture");
        assert(await page.locator("#deliveryMethod").isDisabled());
        assert.equal(await page.locator("#deliveryMethod").inputValue(), "");
        assert.equal((await store.load(id)).settings.deliveryMethod, undefined);
        await page.locator("#homeButton").click();
        await use("套票活動");
        assert(await page.locator("#deliveryMethod").isEnabled());

        // 延遲且拒絕儲存，期間鎖定，失敗後回復啟用狀態
        let release: () => void = () => {};
        const received = page.waitForRequest(
            request => request.method() === "PUT" && request.url().endsWith(`/api/activities/${bundle.id}`),
            { timeout: 5000 },
        );
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        await page.route(`**/api/activities/${bundle.id}`, async route => {
            if (route.request().method() !== "PUT") return route.continue();
            await gate;
            await route.fulfill({ status: 400, json: { error: "fixture 保存拒絕" } });
        });
        try {
            await page.locator("#saveActivity").click();
            await received;
            assert(await page.locator("#deliveryMethod").isDisabled());
        } finally {
            release();
        }
        await page.locator("#message").filter({ hasText: "fixture 保存拒絕" }).waitFor();
        assert(await page.locator("#deliveryMethod").isEnabled());
        assert.equal(await page.locator("#deliveryMethod").inputValue(), "郵寄");
    }));
