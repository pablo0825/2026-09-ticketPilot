import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { readTicketPlusDom } from "../../../src/platforms/ticketplus/domSnapshot.js";
import { DomCaptureError } from "../../../src/platforms/ticketplus/domReadFailure.js";
import { readTicketPlusActivityObservation } from "../../../src/platforms/ticketplus/pageState.js";
import type { TicketPlusPageDiagnostic } from "../../../src/platforms/ticketplus/pageState.js";
import { diagnoseReadFailure } from "../../../src/platforms/ticketplus/readFailure.js";
import { activity } from "../../fixtures/ticketplus/pages.js";

const url = "https://ticketplus.com.tw/activity/event-fixture";
const target = { eventId: "event-fixture", eventName: "2026孿生姐妹之夜之鬼迷心竅" };
const secret = "private@example.invalid-secret";

async function withPage(run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: activity }));
        await page.goto(url);
        await run(page);
    } finally {
        await browser.close();
    }
}

test("DOM 診斷：活動欄位擷取不讀購買區圖示且仍只擷取一次", async () => {
    await withPage(async page => {
        // 保留正式欄位，僅在按鈕區加入載入圖示。
        await page.evaluate(() => {
            document
                .querySelector(".sesstion-item button")!
                .insertAdjacentHTML(
                    "afterend",
                    '<span role="progressbar"><svg width="20" height="20"><circle cx="10" cy="10" r="8" /></svg></span>',
                );
            document.addEventListener("click", () => (document.body.dataset.clicked = "yes"));
        });
        const originalEvaluate = page.evaluate.bind(page);
        let reads = 0;
        page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
            reads += 1;
            return originalEvaluate(...args);
        }) as Page["evaluate"];
        let diagnostic: TicketPlusPageDiagnostic | undefined;
        const result = await readTicketPlusActivityObservation(page, target, value => (diagnostic = value));
        page.evaluate = originalEvaluate;

        assert.equal(reads, 1);
        assert.equal(result.page.kind, "activity");
        assert.equal(result.readiness.status, "ready");
        assert.equal(diagnostic?.readFailure, undefined);
        assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
    });
});

test("DOM 診斷：getter 例外只記固定種類，不回傳原始錯誤或私密自訂標籤", async () => {
    await withPage(async page => {
        await page.evaluate(privateText => {
            const node = document.createElement("div");
            node.className = "row py-1 py-md-4 rwd-margin no-gutters";
            const child = document.createElement("private-customer-tag");
            child.style.display = "block";
            child.textContent = privateText;
            Object.defineProperty(child, "innerText", {
                get() {
                    throw new Error(privateText);
                },
            });
            node.append(child);
            document.body.append(node);
        }, secret);
        await assert.rejects(readTicketPlusDom(page), error => {
            assert(error instanceof DomCaptureError);
            assert.equal(error.detail.operation, "read-inner-text");
            assert.equal(error.detail.valueType, "unread");
            assert.equal(error.detail.tagName, "other");
            assert.equal(error.detail.namespace, "html");
            const serialized = JSON.stringify(diagnoseReadFailure(error, page, "capture-dom", url, url));
            assert(!serialized.includes(secret));
            assert(!serialized.includes("private-customer-tag"));
            assert(!error.message.includes(secret));
            return true;
        });
    });
});

test("DOM 診斷：共用文字 getter 及不合法文字型別皆保留停止，不轉成空字串", async () => {
    await withPage(async page => {
        for (const value of [null, 12, false]) {
            await page.evaluate(next => {
                Object.defineProperty(document.querySelector("h1:not([hidden])")!, "innerText", {
                    configurable: true,
                    get() {
                        return next;
                    },
                });
            }, value);
            await assert.rejects(readTicketPlusDom(page), error => {
                assert(error instanceof DomCaptureError);
                assert.equal(error.detail.field, "page.text");
                assert.equal(error.detail.tagName, "h1");
                assert.equal(error.detail.valueType, typeof value);
                assert.equal(error.detail.rowIndex, null);
                assert.equal(error.detail.elementIndex, null);
                return true;
            });
        }
    });
});

test("DOM 診斷：完整活動成功資料不增加診斷欄位", async () => {
    await withPage(async page => {
        const dom = await readTicketPlusDom(page);
        assert.equal("captureFailure" in dom, false);
        assert.equal(dom.activity[0]?.dates[0], "2026-10-30(五)");
        assert.equal(dom.activity[0]?.times[0], "20:00");
        assert.equal(dom.activity[0]?.saleButtons[0]?.enabled, true);
    });
});

test("DOM 診斷：票種末端文字掃描亦保留欄位與列位置", async () => {
    await withPage(async page => {
        await page.setContent(
            '<div class="row py-1 py-md-4 rwd-margin no-gutters"><span role="progressbar"><svg width="20" height="20"><circle cx="10" cy="10" r="8" /></svg></span></div>',
        );
        await assert.rejects(readTicketPlusDom(page), error => {
            assert(error instanceof DomCaptureError);
            assert.equal(error.detail.field, "tickets.soldOut");
            assert.equal(error.detail.rowIndex, 0);
            assert.equal(error.detail.elementIndex, 0);
            assert.equal(error.detail.tagName, "circle");
            assert.equal(error.detail.namespace, "svg");
            assert.equal(error.detail.valueType, "undefined");
            return true;
        });
    });
});
