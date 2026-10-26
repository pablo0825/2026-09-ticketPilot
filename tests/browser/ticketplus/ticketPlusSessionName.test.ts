import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { selectTicketPlusSession, TicketPlusSessionError } from "../../../src/platforms/ticketplus/sessionSelection.js";
import { activity, session, order } from "../../fixtures/ticketplus/pages.js";

const name = "2026孿生姐妹之夜之鬼迷心竅";
const settings = {
    platform: "ticketplus" as const,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: name,
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 },
};
const options = { activityReadyTimeoutMs: 700, activityPollIntervalMs: 30, arrivalTimeoutMs: 700 };

async function withPage(html: string, run: (page: Page) => Promise<void>, next = order) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route =>
            route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: route.request().url().includes("/order/") ? next : html,
            }),
        );
        await page.addInitScript(() =>
            document.addEventListener("click", event => {
                if (!(event.target as Element).closest(".sesstion-item button")) return;
                sessionStorage.setItem("clicks", String(Number(sessionStorage.getItem("clicks") ?? 0) + 1));
                location.href = "/order/event-fixture/session-A";
            }),
        );
        await page.goto(settings.eventUrl);
        await run(page);
    } finally {
        await browser.close();
    }
}

async function expectStopped(page: Page, reason: string) {
    await assert.rejects(selectTicketPlusSession(page, settings, options), error => {
        assert(error instanceof TicketPlusSessionError);
        if (reason === "activity-ready-timeout") {
            assert([reason, "read-failed"].includes(error.reason));
            assert.equal(error.diagnostic?.check, "page-state");
            if (error.diagnostic?.check === "page-state")
                assert.equal(error.diagnostic.snapshot.readiness?.status, "pending");
        } else {
            assert.equal(error.reason, reason);
        }
        return true;
    });
    assert.equal(await page.evaluate(() => sessionStorage.getItem("clicks")), null);
}

test("名稱定位：不依賴 h1，其他場次時間範圍不阻擋，只點目標一次", async () => {
    const other = session.replace(name, "白天場次").replace("20:00", "10:00 ~ 18:00");
    for (const heading of ["", "<h1>活動總標題</h1>", "<h1>標題一</h1><h1>標題二</h1>"]) {
        await withPage(heading + other + session, async page => {
            const result = await selectTicketPlusSession(page, settings, options);
            assert.equal(result.sessionId, "session-A");
            assert.equal(await page.evaluate(() => sessionStorage.getItem("clicks")), "1");
        });
    }
});

test("名稱定位：名稱空白正規化，標點仍完整比對", async () => {
    const expected = "晚場 [B] (特別)";
    await withPage(
        session.replace(name, "  晚場\n [B]   (特別)  "),
        async page => {
            const result = await selectTicketPlusSession(page, { ...settings, eventName: expected }, options);
            assert.equal(result.eventName, expected);
        },
        order.replace(name, expected),
    );
    await withPage(session.replace(name, name + "加場"), page => expectStopped(page, "session-missing"));
});

test("名稱定位：資料延遲出現才點擊，載入時不刷新", async () => {
    await withPage("<h1>總標題</h1><div>載入中</div>", async page => {
        await page.evaluate(html => {
            setTimeout(() => {
                document.body.innerHTML = html;
            }, 180);
        }, session);
        const result = await selectTicketPlusSession(page, settings, options);
        assert.equal(result.sessionId, "session-A");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("clicks")), "1");
    });
});

test("名稱定位：重複、錯日期時間、目標時間範圍、停用與彈窗零點擊", async () => {
    for (const [html, reason] of [
        [session + session.replace("20:00", "21:00"), "session-ambiguous"],
        [session.replace("2026-10-30", "2026-10-31"), "session-date-mismatch"],
        [session.replace("20:00", "21:00"), "session-time-mismatch"],
        [session.replace("20:00", "10:00 ~ 18:00"), "session-time-invalid"],
        [session.replace('type="button"', 'type="button" disabled'), "session-disabled"],
        [session + '<div role="dialog">未知提示</div>', "unexpected-page"],
    ]) {
        await withPage(html!, page => expectStopped(page, reason!));
    }
});

test("名稱定位：點擊前場次變更重新核對，零點擊", async () => {
    await withPage(activity, async page => {
        // 首次讀取名稱後更換日期，複核必須拒絕新日期。
        await page.evaluate(() => {
            const element = document.querySelector(".is-word-break")! as HTMLElement;
            const value = element.innerText;
            let reads = 0;
            Object.defineProperty(element, "innerText", {
                get() {
                    if (++reads === 1) {
                        queueMicrotask(() => {
                            const fields = document.querySelectorAll(".sesstion-item .d-flex");
                            for (const field of fields) {
                                if (field.children[0]?.textContent === "日期")
                                    field.children[1]!.textContent = "2026-10-31";
                            }
                        });
                    }
                    return value;
                },
            });
        });
        await expectStopped(page, "button-unavailable");
    });
});
