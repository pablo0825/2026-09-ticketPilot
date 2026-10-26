import assert from "node:assert/strict";
import { test } from "node:test";
import { withBrowserPage } from "../../fixtures/browserPage.js";
import type { Page } from "playwright";
import { submitTicketPlusInformation } from "../../../src/platforms/ticketplus/informationSubmission.js";
import { TicketPlusRunControl } from "../../../src/platforms/ticketplus/runControl.js";
import {
    informationBehavior,
    purchaseCheckout,
    mixedCheckout,
    purchaseInformation,
    registerCheckout,
} from "../../fixtures/ticketplus/informationSubmitPage.js";
import type { InformationOptions, NextMode } from "../../fixtures/ticketplus/informationSubmitPage.js";

const confirmPath = "/confirm/event-fixture/session-B";
const checkoutPath = "/checkout/event-fixture/session-B";
const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};
const keys = ["terms", "link", "next", "pay", "cancel", "back"] as const;

async function withInformation(
    options: InformationOptions,
    mode: NextMode,
    run: (page: Page, counts: () => Promise<Record<string, number>>) => Promise<void>,
    checkoutHtml = purchaseCheckout,
) {
    return withBrowserPage(async page => {
        await page.route("**/*", route => {
            const path = new URL(route.request().url()).pathname;
            const body =
                path === confirmPath
                    ? purchaseInformation(options) + informationBehavior(mode, checkoutPath)
                    : path === checkoutPath
                      ? checkoutHtml + informationBehavior(mode, checkoutPath)
                      : "<html><body>其他頁面</body></html>";
            return route.fulfill({ contentType: "text/html; charset=utf-8", body });
        });
        await page.goto("https://ticketplus.com.tw" + confirmPath);
        const counts = () =>
            page.evaluate(
                names =>
                    Object.fromEntries(
                        names.map(name => [name, Number(sessionStorage.getItem("info-" + name) ?? "0")]),
                    ),
                [...keys],
            );
        await run(page, counts);
    });
}

const none = { terms: 0, link: 0, next: 0, pay: 0, cancel: 0, back: 0 };

test("資料頁送出：三種購票資料頁皆勾條款一次、按下一步一次，停在付款頁不付款", async () => {
    for (const detail of ["row", "standing", "seated"] as const) {
        await withInformation({ detail }, "to-checkout", async (page, counts) => {
            const result = await submitTicketPlusInformation(page, session, new TicketPlusRunControl());
            assert.deepEqual(result, { outcome: "payment-ready" });
            assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
            // 付款方式維持未勾選
            assert.equal(await page.locator('input[name="payment"]:checked').count(), 0);
        });
    }
});

test("資料頁送出：條款已勾時不再點條款", async () => {
    await withInformation({ termsChecked: true }, "to-checkout", async (page, counts) => {
        assert.deepEqual(await submitTicketPlusInformation(page, session, new TicketPlusRunControl()), {
            outcome: "payment-ready",
        });
        assert.deepEqual(await counts(), { ...none, next: 1 });
    });
});

test("資料頁送出：三個聯絡欄位空白或不存在仍送出一次並停在付款頁", async () => {
    for (const missing of [false, true]) {
        await withInformation({}, "to-checkout", async (page, counts) => {
            // 模擬會員欄位尚未帶值或無法辨識，不將個資作為送出條件。
            await page.locator('input[id^="contact-"]').evaluateAll((inputs, remove) => {
                for (const input of inputs) {
                    if (remove) {
                        input.remove();
                    } else {
                        (input as HTMLInputElement).value = "";
                    }
                }
            }, missing);

            // 核對只勾條款與按下一步，付款保持未操作。
            const result = await submitTicketPlusInformation(page, session, new TicketPlusRunControl());
            assert.deepEqual(result, { outcome: "payment-ready" });
            assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
            assert.equal(await page.locator('input[name="payment"]:checked').count(), 0);
        });
    }
});

test("資料頁送出：抽選輸入資料頁或活動場次不符時零點擊停止", async () => {
    for (const expected of [
        { ...session, eventId: "other-event" },
        { ...session, sessionId: "other-session" },
        session,
    ]) {
        await withInformation({ participants: expected === session }, "to-checkout", async (page, counts) => {
            const result = await submitTicketPlusInformation(page, expected, new TicketPlusRunControl());
            assert.deepEqual(result, { outcome: "stopped", reason: "not-purchase-page" });
            assert.deepEqual(await counts(), none);
        });
    }
});

test("資料頁送出：已停止時零點擊回報停止", async () => {
    await withInformation({}, "to-checkout", async (page, counts) => {
        const abort = new AbortController();
        abort.abort();
        assert.deepEqual(await submitTicketPlusInformation(page, session, new TicketPlusRunControl(abort.signal)), {
            outcome: "stopped",
            reason: "user-stopped",
        });
        assert.deepEqual(await counts(), none);
    });
});

test("資料頁送出：按下一步後停留原頁或跳出彈窗，回報未確認且不重按", async () => {
    for (const mode of ["stay", "dialog"] as const) {
        await withInformation({}, mode, async (page, counts) => {
            assert.deepEqual(
                await submitTicketPlusInformation(page, session, new TicketPlusRunControl(), { timeoutMs: 800 }),
                { outcome: "unknown", reason: "checkout-not-reached" },
            );
            assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
        });
    }
});

test("資料頁送出：點條款後仍未勾選時停止，不按下一步也不再點條款", async () => {
    await withInformation({}, "terms-inert", async (page, counts) => {
        assert.deepEqual(await submitTicketPlusInformation(page, session, new TicketPlusRunControl()), {
            outcome: "stopped",
            reason: "terms-unchecked",
        });
        assert.deepEqual(await counts(), { ...none, terms: 1 });
    });
});

test("資料頁送出：下一步後到的是確認登記頁，不當成付款頁", async () => {
    await withInformation(
        {},
        "to-checkout",
        async (page, counts) => {
            assert.deepEqual(
                await submitTicketPlusInformation(page, session, new TicketPlusRunControl(), { timeoutMs: 800 }),
                { outcome: "unknown", reason: "checkout-not-reached" },
            );
            assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
        },
        registerCheckout,
    );
});

test("資料頁送出：付款頁跳出彈窗或同時有確認登記時不算抵達", async () => {
    for (const [mode, checkoutHtml] of [
        ["checkout-dialog", undefined],
        ["to-checkout", mixedCheckout],
    ] as const) {
        await withInformation(
            {},
            mode,
            async (page, counts) => {
                assert.deepEqual(
                    await submitTicketPlusInformation(page, session, new TicketPlusRunControl(), { timeoutMs: 800 }),
                    { outcome: "unknown", reason: "checkout-not-reached" },
                );
                assert.deepEqual(await counts(), { ...none, terms: 1, next: 1 });
            },
            checkoutHtml,
        );
    }
});

test("資料頁送出：點擊前的非預期讀取錯誤回報停止，不當成結果未確認", async () => {
    await withInformation({}, "to-checkout", async (page, counts) => {
        // 條款定位時頁面內容被替換，讀取丟出一般錯誤
        page.evaluateHandle = (() => Promise.reject(new Error("Execution context was destroyed"))) as never;
        assert.deepEqual(await submitTicketPlusInformation(page, session, new TicketPlusRunControl()), {
            outcome: "stopped",
            reason: "read-failed",
        });
        assert.deepEqual(await counts(), none);
    });
});
