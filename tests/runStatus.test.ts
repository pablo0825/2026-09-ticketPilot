import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("執行狀態簡化：階段分組、等待倒數、結束文案及紀錄隔離", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-status-"));
    const service = await startLocalServer(new ActivityStore(join(dir, "events")), {
        contactPath: join(dir, "contact.json"),
        runDirectory: join(dir, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const base = {
            id: "fixture",
            activityName: "測試活動",
            status: "running",
            browserOpen: true,
            occupied: true,
            canCloseBrowser: false,
            message: "正在啟動購票，請勿重複開始。",
            historyTruncated: false,
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", { ...base, events: [] });
        await page.goto(service.url);
        await page.locator("#selectKlook").click();
        await page.locator("#viewRun").click();
        await page.locator("#step4").waitFor();
        let sequence = 0;
        const render = async (state: string, fields: Record<string, unknown> = {}) => {
            const marker = `測試事件 ${++sequence}`;
            const run = {
                ...base,
                ...fields,
                events: [
                    ...((fields.events as unknown[] | undefined) ?? [
                        { at: new Date().toISOString(), event: { type: "state", state } },
                    ]),
                    { at: new Date().toISOString(), event: { type: "log", message: marker } },
                ],
            };
            feed.publish(run);
            if (run.id === "fixture")
                await eventually(async () => assert((await page.locator("#logs").innerText()).includes(marker)));
            else await eventually(async () => assert.equal(await page.locator("#homeRun").textContent(), ""));
        };
        for (const state of [
            "STARTING",
            "LOGIN_CHECK",
            "EVENT_PAGE",
            "READY",
            "SALE_REFRESH",
            "TICKET_SELECTION",
            "SELECTION_VERIFIED",
            "SEAT_ASSIGNMENT",
            "SEATS_VERIFIED",
            "SEAT_CONFIRMATION",
            "PERSONAL_INFO_READY",
            "BOOKING_VERIFIED",
            "CONTACT_FILLING",
            "CONTACT_VERIFIED",
            "CONTACT_SUBMISSION",
            "RECOVERING",
            "PAYMENT_READY",
        ]) {
            await render(state);
            assert.equal(await page.locator("#status").innerText(), "正在購票");
            assert.match(await page.locator("#instruction").innerText(), /依照設定執行/);
            assert(await page.locator("#closeBrowser").isHidden());
        }
        for (const [state, label] of [
            ["QUEUE_COUNTDOWN", "等待排隊開賣"],
            ["WAITING_IN_QUEUE", "排隊中"],
            ["QUEUE_CONTINUING", "等待進入購票頁"],
        ]) {
            await render(state!);
            assert.equal(await page.locator("#status").innerText(), label);
        }
        await render("WAITING_FOR_LOGIN");
        assert.equal(await page.locator("#status").innerText(), "請手動登入");
        assert.match(await page.locator("#instruction").innerText(), /登入.*自動繼續/);
        await render("WAITING_FOR_SALE", { saleAt: new Date(Date.now() + 60_000).toISOString() });
        assert.equal(await page.locator("#status").innerText(), "等待開賣");
        assert.match(await page.locator("#instruction").innerText(), /台灣時間.*距開賣 \d+ 秒/);
        await render("SALE_REFRESH", { saleAt: new Date(Date.now() + 60_000).toISOString() });
        assert.doesNotMatch(await page.locator("#instruction").innerText(), /距開賣/);
        await render("MANUAL_REQUIRED");
        assert.equal(await page.locator("#status").innerText(), "購票已停止");
        assert(await page.locator("#closeBrowser").isHidden());
        for (const status of ["failed", "unknown", "interrupted"]) {
            await render("CONTACT_SUBMISSION", { status, canCloseBrowser: status !== "interrupted" });
            assert.equal(await page.locator("#status").innerText(), "購票已停止");
            if (status === "unknown")
                assert.match(await page.locator("#instruction").innerText(), /提交結果尚未確認.*不會重新提交/);
            if (status === "interrupted") assert.match(await page.locator("#instruction").innerText(), /程序異常中斷/);
        }
        await render("PAYMENT_READY", { status: "payment-ready", canCloseBrowser: true });
        assert.equal(await page.locator("#status").innerText(), "已到付款頁");
        assert.match(await page.locator("#instruction").innerText(), /手動完成付款/);
        assert(await page.locator("#closeBrowser").isVisible());
        await render("PAYMENT_READY", { status: "payment-ready", browserOpen: false });
        assert.match(await page.locator("#instruction").innerText(), /等待程序結束/);
        await render("PAYMENT_READY", { status: "payment-ready", browserOpen: false, occupied: false });
        assert.match(await page.locator("#instruction").innerText(), /已關閉.*未核對付款結果/);
        assert.doesNotMatch(await page.locator("#instruction").innerText(), /請到.*手動完成付款/);
        const at = new Date().toISOString();
        await render("TICKET_SELECTION", {
            events: [
                { at, event: { type: "log", message: "原始紀錄" } },
                {
                    at,
                    event: {
                        type: "target",
                        index: 2,
                        total: 3,
                        date: "2026-11-15",
                        time: "17:00",
                        area: "B區",
                        quantity: 2,
                        totalPrice: 2560,
                    },
                },
                { at, event: { type: "recovery", queue: 1, reservation: 0 } },
            ],
        });
        const logs = await page.locator("#logs").innerText();
        assert.match(logs, /本次活動：測試活動/);
        assert.match(logs, /順位 2\/3.*2026-11-15 17:00.*B區/);
        assert.match(logs, /恢復額度：排隊 1\/1；預留 0\/1/);
        assert.match(logs, /原始紀錄/);
        assert.equal(await page.locator("#runLabel, #target, #budget, #browser, #countdown").count(), 0);
        await render("WAITING_FOR_LOGIN", { id: "other", occupied: false });
        await page.waitForTimeout(1100);
        assert.equal(await page.locator("#status").innerText(), "正在購票");
        assert.equal(await page.locator("#logs").innerText(), logs);
        await page.screenshot({ path: "/tmp/ticket-simple-status.png", fullPage: true });
    } finally {
        await browser.close();
        await service.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("長紀錄在窄螢幕可捲動，閱讀舊紀錄時不被新事件拉回底部", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-status-scroll-"));
    const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
        contactPath: join(directory, "contact.json"),
        runDirectory: join(directory, "runtime"),
    });
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const run = {
            id: "scroll-fixture",
            platform: "ticketplus",
            flowType: "purchase",
            activityName: "長紀錄測試",
            status: "running",
            occupied: true,
            browserOpen: true,
            canCloseBrowser: false,
            historyTruncated: false,
            events: Array.from({ length: 60 }, (_, index) => ({
                at: new Date().toISOString(),
                event: { type: "log", message: `紀錄 ${index} ${"長文字".repeat(30)}` },
            })),
        };
        const feed = await snapshotFeed(page, "/api/purchase/events", run);
        await page.goto(service.url);
        await page.locator("#platformViewRun").click();
        await page.locator("details > summary").click();
        const logs = page.getByLabel("執行紀錄", { exact: true });
        assert(await logs.evaluate(el => el.scrollHeight > el.clientHeight));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const append = (message: string) => {
            run.events.push({ at: new Date().toISOString(), event: { type: "log", message } });
            feed.publish(run);
        };
        append("跟隨新事件");
        await eventually(async () => {
            assert.match(await logs.innerText(), /跟隨新事件/);
            assert(await logs.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2));
        });
        await logs.evaluate(el => {
            el.scrollTop = 0;
            el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        append("保留閱讀位置");
        await eventually(async () => assert.match(await logs.innerText(), /保留閱讀位置/));
        assert.equal(await logs.evaluate(el => el.scrollTop), 0);
        assert(await page.locator("#closeBrowser").isHidden());
    } finally {
        await browser.close();
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
