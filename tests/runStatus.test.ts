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
        await page.goto(service.url);
        await page.locator("#new").click();
        await page.evaluate("displayedRun = {kind:'purchase',id:'fixture'}; showStep(4)");
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
        const render = async (state: string, fields = {}) => {
            await page.evaluate(run => (window as any).render(run), {
                ...base,
                events: [{ at: new Date().toISOString(), event: { type: "state", state } }],
                ...fields,
            });
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
        await render("WAITING_FOR_LOGIN", { id: "other" });
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
