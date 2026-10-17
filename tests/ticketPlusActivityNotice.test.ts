import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { readTicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";
import * as fixture from "./fixtures/ticketplus/pages.js";
import { noticeDialog, noticeTitles } from "./fixtures/ticketplus/activityNotice.js";

const origin = "https://ticketplus.com.tw";
const eventId = "0233a891800ffaa343bf8bff73d390e8";
const sessionId = "62ecd68cb52728a63ac9cff43172e04f";
const activityUrl = `${origin}/activity/${eventId}`;
const orderUrl = `${origin}/order/${eventId}/${sessionId}`;

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
        );
        await run(page);
    } finally {
        await browser.close();
    }
}

async function show(page: Page, url: string, html: string): Promise<void> {
    await page.goto(url);
    await page.setContent(html);
}

test("提醒彈窗：兩種白名單標題讀成 notice，活動頁回報 notice-dialog", async () => {
    await withPage(async page => {
        for (const title of [noticeTitles.lottery, noticeTitles.entry]) {
            await show(page, activityUrl, fixture.activity + noticeDialog(title));

            // 只回傳分類與標題，不帶出內文
            const dom = await readTicketPlusDom(page);
            assert.equal(dom.dialogs.length, 1);
            assert.equal(dom.dialogs[0]!.kind, "notice");
            assert.equal(dom.dialogs[0]!.noticeTitle, title);

            // 活動頁只有提醒時明確回報，與未知彈窗區分
            assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "notice-dialog" });
        }
    });
});

test("提醒彈窗：未知標題、按鈕不齊、非活動頁都不算 notice", async () => {
    await withPage(async page => {
        // 未知標題仍是阻擋彈窗
        await show(page, activityUrl, fixture.activity + noticeDialog("購票須知"));
        assert.equal((await readTicketPlusDom(page)).dialogs[0]!.kind, "unknown");
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "blocking-dialog" });

        // 缺少「回到首頁」或多一顆按鈕都不接受
        for (const buttons of [["確定"], ["回到首頁", "確定", "取消"], ["回到首頁", "確定", "確定"]]) {
            await show(page, activityUrl, fixture.activity + noticeDialog(noticeTitles.entry, buttons));
            assert.equal((await readTicketPlusDom(page)).dialogs[0]!.kind, "unknown");
        }

        // 提醒與未知彈窗並存時仍是阻擋彈窗
        await show(page, activityUrl, fixture.activity + noticeDialog(noticeTitles.entry) + noticeDialog("購票須知"));
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "blocking-dialog" });

        // order 頁同結構不算 notice
        await show(page, orderUrl, fixture.order + noticeDialog(noticeTitles.entry));
        assert.equal((await readTicketPlusDom(page)).dialogs[0]!.kind, "unknown");
    });
});
