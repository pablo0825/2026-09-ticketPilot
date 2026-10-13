import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { readQueueSnapshot } from "../src/platforms/klook/queuePage.js";
import type { QueueSnapshot } from "../src/platforms/klook/queuePage.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/102001116-fixture/";
const frame =
    '<iframe class="dynamic-frame" src="https://cdn.klook.com/event/queue-snapshot/102001116/zh_TW/web/fixture.html"></iframe>';
const wrap = (body: string, source = frame) => `<main class="event_queue_desktop">${source}${body}</main>`;
const countdown = "<div>開賣倒數 <span>01</span> : <span>02</span> : <span>03</span></div>";
const admitted = "<h2>輪到你了，請盡快完成購票！</h2><div>順位保留倒數 <span>04</span> : <span>41</span></div>";
const waiting = '<h2>排隊中</h2><span class="qmotion__pct">100%</span>';

test("排隊快照分類：時間精確換算、100%仍等待，缺資料與非法時間為未知", async () => {
    const cases: { name: string; html: string; expected: QueueSnapshot }[] = [
        { name: "拆分倒數", html: wrap(countdown), expected: { stage: "countdown", seconds: 3723 } },
        { name: "倒數歸零", html: wrap("<div>開賣倒數 00:00:00</div>"), expected: { stage: "countdown", seconds: 0 } },
        { name: "100%未放行", html: wrap(waiting), expected: { stage: "waiting" } },
        { name: "順位剩餘秒數", html: wrap(admitted), expected: { stage: "admitted", seconds: 281 } },
        { name: "倒數分鐘越界", html: wrap("<div>開賣倒數 00:60:00</div>"), expected: { stage: "unknown" } },
        { name: "倒數秒數越界", html: wrap("<div>開賣倒數 00:00:60</div>"), expected: { stage: "unknown" } },
        {
            name: "順位秒數越界",
            html: wrap(admitted.replace("41</span>", "60</span>")),
            expected: { stage: "unknown" },
        },
        { name: "順位時間缺失", html: wrap("<h2>輪到你了，請盡快完成購票！</h2>"), expected: { stage: "unknown" } },
        { name: "iframe缺失", html: wrap(countdown, ""), expected: { stage: "unknown" } },
        {
            name: "src缺失",
            html: wrap(countdown, '<iframe class="dynamic-frame"></iframe>'),
            expected: { stage: "unknown" },
        },
        { name: "排隊區缺失", html: "", expected: { stage: "unknown" } },
    ];
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ body: "" }));
        for (const item of cases) {
            await page.setContent(item.html);
            assert.deepEqual(await readQueueSnapshot(page, eventUrl), item.expected, item.name);
        }
    } finally {
        await browser.close();
    }
});

test("排隊快照停止原因與優先序：提示、來源、衝突及順位過期", async () => {
    const cases = [
        {
            name: "缺排隊區但有提示",
            html: '<div role="dialog">提示</div>',
            reason: "排隊頁出現提示，請人工檢查；不會自動重新入隊。",
        },
        { name: "多來源", html: wrap(countdown, frame + frame), reason: "排隊頁活動資料不唯一，已停止。" },
        { name: "多排隊區", html: wrap(countdown) + wrap(countdown), reason: "排隊頁活動資料不唯一，已停止。" },
        {
            name: "错活動與合法倒數",
            html: wrap(countdown, frame.replace("/102001116/", "/999/")),
            reason: "排隊頁與設定活動不符，已停止。",
        },
        {
            name: "错CDN與合法倒數",
            html: wrap(countdown, frame.replace("cdn.klook.com", "example.com")),
            reason: "排隊頁與設定活動不符，已停止。",
        },
        {
            name: "重複入口",
            html: wrap(countdown + "<button>排隊購票</button><button>排隊購票</button>"),
            reason: "排隊頁狀態重複或互相矛盾，已停止。",
        },
        { name: "放行與倒數並存", html: wrap(admitted + countdown), reason: "排隊放行狀態互相矛盾，已停止。" },
        {
            name: "順位歸零",
            html: wrap(admitted.replace("04</span>", "00</span>").replace("41</span>", "00</span>")),
            reason: "順位保留已過期，已停止；不會重新入隊。",
        },
    ];
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ body: "" }));
        for (const item of cases) {
            await page.setContent(item.html);
            await assert.rejects(readQueueSnapshot(page, eventUrl), error => {
                assert(error instanceof PurchaseStop, item.name);
                assert.equal(error.message, item.reason, item.name);
                return true;
            });
        }
    } finally {
        await browser.close();
    }
});

test("排隊文字計數：巢狀文字只計一次，隱藏入口不計，英文排隊仍可辨認", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ body: "" }));
        await page.setContent(
            wrap(countdown + "<button><span>排隊購票</span></button><button hidden>排隊購票</button>"),
        );
        assert.deepEqual(await readQueueSnapshot(page, eventUrl), { stage: "countdown", seconds: 3723 });
        await page.setContent(wrap(waiting.replace("排隊中", "You're now in the queue!")));
        assert.deepEqual(await readQueueSnapshot(page, eventUrl), { stage: "waiting" });
        await page.setContent(wrap(admitted + "<button><span>繼續預訂</span></button>"));
        assert.deepEqual(await readQueueSnapshot(page, eventUrl), { stage: "admitted", seconds: 281 });
    } finally {
        await browser.close();
    }
});
