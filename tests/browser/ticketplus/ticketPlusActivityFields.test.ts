import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusDom } from "../../../src/platforms/ticketplus/domSnapshot.js";
import { readTicketPlusActivityObservation, readTicketPlusPage } from "../../../src/platforms/ticketplus/pageState.js";
import { selectTicketPlusSession } from "../../../src/platforms/ticketplus/sessionSelection.js";
import type { TicketPlusSelection } from "../../../src/config/platforms/ticketplus/activitySettings.js";
import { order } from "../../fixtures/ticketplus/pages.js";
import {
    observedActivity,
    observedField,
    observedLoading,
    observedSpinner,
    observedBuyButton,
    observedEventName,
} from "../../fixtures/ticketplus/observedActivityFields.js";

const activityUrl = "https://ticketplus.com.tw/activity/event-fixture";
const target = { eventId: "event-fixture", eventName: observedEventName };
const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: activityUrl,
    eventName: observedEventName,
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: new URL(route.request().url()).pathname.startsWith("/order/")
                    ? order.replace("<div>1</div>", "<div>0</div>")
                    : observedActivity(),
            }),
        );
        await page.goto(activityUrl);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function expectActivity(page: Page): Promise<void> {
    const result = await readTicketPlusPage(page);
    assert.equal(result.kind, "activity");
    if (result.kind !== "activity") assert.fail();
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0]!.date, "2026-10-30");
    assert.equal(result.sessions[0]!.time, "20:00");
}

test("活動欄位：寬窄版標籤可辨識，裝飾圖示不改日期時間", async () => {
    await withPage(async page => {
        for (const width of [1280, 390]) {
            await page.setViewportSize({ width, height: 800 });
            for (const extra of ["", observedSpinner, "<span>1999-01-01</span><span>01:23</span>"]) {
                await page.setContent(observedActivity({ extra }));
                await expectActivity(page);
            }
            await page.setContent(observedActivity({ button: observedSpinner + observedBuyButton }));
            await expectActivity(page);
        }
    });
});

test("活動欄位：按鈕被進度圖示取代時仍能讀取但不放行", async () => {
    await withPage(async page => {
        await page.setContent(observedActivity({ button: observedSpinner }));
        const dom = await readTicketPlusDom(page);
        assert.deepEqual(dom.activity[0]!.dates, ["2026-10-30(五)"]);
        assert.deepEqual(dom.activity[0]!.times, ["20:00"]);
        assert.deepEqual(dom.activity[0]!.saleButtons, []);
        const observation = await readTicketPlusActivityObservation(page, target);
        assert.equal(observation.page.kind, "unknown");
        assert.equal(observation.readiness.status, "pending");
    });
});

test("活動欄位：欄位外文字不能補缺值，可見重複及空欄位不放行", async () => {
    await withPage(async page => {
        const date = observedField("日期", "2026-10-30(五)");
        const time = observedField("時間", "20:00");
        const cases = [
            { fields: time, extra: "<div>2026-10-30(五)</div>" },
            { fields: observedField("日期", "") + time, extra: "<div>2026-10-30(五)</div>" },
            { fields: date + time + observedField("日期", "") },
            { fields: date + date + time },
            {
                fields:
                    observedField("日期", "2026-10-30(五)").replace("</div></div>", "</div><div></div></div>") + time,
            },
            { fields: observedField("日期", "說明 2026-10-30(五)") + time },
            { fields: observedField("日期", "2026-10-30(五) ~ 2026-11-01(日)") + time },
            { fields: date + observedField("時間", ""), extra: "<div>20:00</div>" },
        ];
        for (const item of cases) {
            await page.setContent(observedActivity(item));
            assert.notEqual((await readTicketPlusPage(page)).kind, "activity");
        }
        await page.setContent(observedActivity({ extra: `<div hidden>${date}${time}</div>` }));
        await expectActivity(page);
    });
});

test("活動欄位：寬窄日期範圍都保留兩值，載入範圍不能成為場次", async () => {
    await withPage(async page => {
        for (const narrow of [false, true]) {
            await page.setViewportSize({ width: narrow ? 390 : 1280, height: 800 });
            await page.setContent(observedLoading(narrow));
            const dom = await readTicketPlusDom(page);
            assert.deepEqual(dom.activity[0]!.dates, ["2024-05-20(一)", "2024-12-31(二)"]);
            assert.deepEqual(dom.activity[0]!.times, []);
            assert.deepEqual(dom.activity[0]!.timeRanges, ["19:00 ~ 23:59"]);
            const result = await readTicketPlusActivityObservation(page, target);
            assert.equal(result.loading, "loading-placeholder");
            assert.equal(result.readiness.status, "pending");
        }
    });
});

test("活動欄位：獨立回應完成才點擊一次，過渡圖示期間零點擊", async () => {
    await withPage(async page => {
        // 點擊計數由網站事件建立，不依正式 reader 呼叫次數更新內容。
        await page.addInitScript(() => {
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                const key = button.closest(".sesstion-item") ? "buy" : "other";
                sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
                if (key === "buy") location.href = "/order/event-fixture/session-A";
            });
        });
        await page.route("**/activity/event-fixture", route =>
            route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: observedActivity({ button: observedSpinner }),
            }),
        );
        await page.reload();
        let release!: () => void;
        let requested!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const request = new Promise<void>(resolve => {
            requested = resolve;
        });
        await page.route("**/fixture-fields-ready", async route => {
            requested();
            await gate;
            await route.fulfill({ contentType: "text/html; charset=utf-8", body: observedActivity() });
        });
        await page.evaluate(() => {
            void fetch("/fixture-fields-ready")
                .then(response => response.text())
                .then(html => {
                    document.body.innerHTML = html;
                });
        });
        try {
            await Promise.race([
                request,
                delay(3000).then(() => {
                    throw new Error("fixture request did not arrive");
                }),
            ]);
        } catch (error) {
            release();
            throw error;
        }
        const outcome = selectTicketPlusSession(page, settings, {
            activityReadyTimeoutMs: 3000,
            activityPollIntervalMs: 30,
            arrivalTimeoutMs: 2000,
        }).then(
            value => ({ value }),
            error => ({ error }),
        );
        try {
            await delay(250);
            assert.equal(await page.evaluate(() => sessionStorage.getItem("buy")), null);
            release();
            const result = await outcome;
            if ("error" in result) throw result.error;
            assert.equal(result.value.sessionId, "session-A");
            assert.equal(await page.evaluate(() => sessionStorage.getItem("buy")), "1");
            assert.equal(await page.evaluate(() => sessionStorage.getItem("other")), null);
        } finally {
            release();
            await outcome;
        }
    });
});
