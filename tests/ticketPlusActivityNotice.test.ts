import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { readTicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";
import * as fixture from "./fixtures/ticketplus/pages.js";
import { noticeBehavior, noticeDialog, noticeTitles } from "./fixtures/ticketplus/activityNotice.js";
import type { NoticeMode } from "./fixtures/ticketplus/activityNotice.js";
import { dismissTicketPlusActivityNotice, TicketPlusNoticeError } from "../src/platforms/ticketplus/activityNotice.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";

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

async function clicks(page: Page): Promise<{ ok: number; back: number }> {
    return page.evaluate(() => (window as unknown as { __noticeClicks: { ok: number; back: number } }).__noticeClicks);
}

async function showNotice(page: Page, title: string, mode: NoticeMode = "dismiss", buttons?: string[]) {
    await show(page, activityUrl, fixture.activity + noticeDialog(title, buttons) + noticeBehavior(mode));
}

async function rejectsNotice(promise: Promise<unknown>): Promise<void> {
    await assert.rejects(promise, error => {
        assert(error instanceof TicketPlusNoticeError);
        assert.equal(error.reason, "notice-dismiss-failed");
        return true;
    });
}

test("關閉提醒：兩種標題各按「確定」一次，不按「回到首頁」", async () => {
    await withPage(async page => {
        for (const title of [noticeTitles.lottery, noticeTitles.entry]) {
            await showNotice(page, title);
            assert.equal(await dismissTicketPlusActivityNotice(page, new TicketPlusRunControl()), "dismissed");
            assert.deepEqual(await clicks(page), { ok: 1, back: 0 });
            assert.equal((await readTicketPlusPage(page)).kind, "activity");
        }
    });
});

test("關閉提醒：沒有彈窗時零點擊回 none", async () => {
    await withPage(async page => {
        await show(page, activityUrl, fixture.activity + noticeBehavior());
        assert.equal(await dismissTicketPlusActivityNotice(page, new TicketPlusRunControl()), "none");
        assert.deepEqual(await clicks(page), { ok: 0, back: 0 });
    });
});

test("關閉提醒：未知標題或按鈕不齊時零點擊並停止", async () => {
    await withPage(async page => {
        await showNotice(page, "購票須知");
        await rejectsNotice(dismissTicketPlusActivityNotice(page, new TicketPlusRunControl()));
        assert.deepEqual(await clicks(page), { ok: 0, back: 0 });

        await showNotice(page, noticeTitles.entry, "dismiss", ["確定"]);
        await rejectsNotice(dismissTicketPlusActivityNotice(page, new TicketPlusRunControl()));
        assert.deepEqual(await clicks(page), { ok: 0, back: 0 });
    });
});

test("關閉提醒：按後同一次載入重現或未消失時停止，不再點第二次", async () => {
    await withPage(async page => {
        await showNotice(page, noticeTitles.entry, "reappear");
        await rejectsNotice(dismissTicketPlusActivityNotice(page, new TicketPlusRunControl()));
        assert.deepEqual(await clicks(page), { ok: 1, back: 0 });

        await showNotice(page, noticeTitles.entry, "stuck");
        await rejectsNotice(dismissTicketPlusActivityNotice(page, new TicketPlusRunControl(), { timeoutMs: 500 }));
        assert.deepEqual(await clicks(page), { ok: 1, back: 0 });
    });
});
