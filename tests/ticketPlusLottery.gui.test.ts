import { enterTicketPlus } from "./fixtures/guiTestHelpers.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";

async function eventually(check: () => Promise<void>, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            return await check();
        } catch (error) {
            if (Date.now() > deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
}

test(
    "抽選 GUI：等待參加者時顯示提示與「參加者已填完」，按下後只送出一次並停在確認登記前",
    { timeout: 40_000 },
    async () => {
        const h = await apiHarness("lottery");
        const browser = await chromium.launch();
        try {
            // 以 API 建立並啟動抽選，登入後等到輸入資料頁
            const activity = { ...apiActivity, flowType: "lottery" };
            const created = await (await h.request("/api/activities", activity)).json();
            await h.request("/api/purchase", {
                requestId: randomUUID(),
                activityId: created.id,
                expectedActivity: activity,
            });
            await h.until(run =>
                Boolean(
                    run?.events.some(
                        item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
                    ),
                ),
            );
            await h.login();
            await h.until(run => Boolean(run?.participantConfirmation));

            // 從活動列表查看目前狀態
            const page = await browser.newPage();
            const posts: string[] = [];
            page.on("request", request => {
                if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
            });
            await page.goto(h.url);
            await enterTicketPlus(page);
            await page.getByRole("button", { name: "查看狀態", exact: true }).click();
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "請填寫參加者"));
            assert.match(await page.locator("#instruction").innerText(), /網站倒數結束前須完成/);
            const confirm = page.getByRole("button", { name: "參加者已填完", exact: true });

            // 從首頁進入也顯示登記抽選步驟；按鈕只有一個，放在填寫參加者這一步，開發者紀錄預設收合。
            const steps = page.getByRole("list", { name: "執行步驟" });
            assert.equal(await steps.getByRole("listitem").count(), 8);
            assert.equal(await confirm.count(), 1);
            assert.equal(
                await steps.getByRole("listitem").filter({ has: confirm }).locator(".run-step-label").innerText(),
                "填寫參加者",
            );
            assert.equal(await page.locator("#logs").isVisible(), false);
            await page.locator("details.dev-log > summary", { hasText: "開發者紀錄" }).click();
            assert.equal(await page.locator("#logs").isVisible(), true);
            // 展開後只保留複製按鈕，不再重複一個「開發者紀錄」標題
            assert.equal(await page.locator("details.dev-log h3").count(), 0);
            assert.equal(await page.locator("details.dev-log #copy").isVisible(), true);

            // 連點只送出一次，之後按鈕消失
            await confirm.evaluate(button => {
                (button as HTMLButtonElement).click();
                (button as HTMLButtonElement).click();
            });
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已停在確認登記前"));
            assert.equal(posts.filter(path => path === "/api/purchase/confirm-participants").length, 1);
            assert.equal(await confirm.count(), 0);
            assert.equal((await h.counts()).counts.terms, 1);
        } finally {
            await browser.close();
            await h.dispose();
        }
    },
);
