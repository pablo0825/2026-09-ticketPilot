import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { presale, summary } from "./fixtures/ticketplus/pages.js";
import { runTicketPlusSubmission, stoppedSubmissionResult } from "../src/platforms/ticketplus/submissionOutcome.js";
import { ticketPlusResultMessage } from "../src/app/ticketPlusPresentation.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import { chromium } from "playwright";
import type { Page, ElementHandle } from "playwright";
import { submitTicketPlusSelection, TicketPlusSubmissionError } from "../src/platforms/ticketplus/ticketSubmission.js";
import type { TicketSubmissionOptions } from "../src/platforms/ticketplus/ticketSubmission.js";
import type { TicketPlusSelection } from "../src/config/ticketPlusActivity.js";
import type { TicketSelectionPage } from "../src/platforms/ticketplus/ticketSelectionPage.js";
import { readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import { selectTicketPlusTickets } from "../src/platforms/ticketplus/ticketQuantity.js";
import { selectTicketPlusSession } from "../src/platforms/ticketplus/sessionSelection.js";
import {
    installSubmission,
    lotteryQueueDialog,
    submissionCounts,
    failureDialog,
    queueDialog,
    readyOrder,
    readyInformation,
} from "./fixtures/ticketplus/submissionPage.js";
import type { Mode } from "./fixtures/ticketplus/submissionPage.js";

const settings: TicketPlusSelection = {
    platform: "ticketplus",
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
};
// 手寫期望值，不用正式 reader 產生輸入與答案。
const selection: TicketSelectionPage = {
    kind: "ticket-selection",
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: settings.eventName,
    date: "2026-10-30",
    time: "20:00",
    nextEnabled: true,
    tickets: [
        {
            area: null,
            name: "預售票",
            selectedQuantity: 2,
            saleStatus: "selling",
            remainingQuantity: null,
            canIncrease: true,
            canDecrease: true,
        },
    ],
    areas: [],
};
const options: TicketSubmissionOptions = {
    preflightTimeoutMs: 2_000,
    submitWaitMs: 1_000,
    queueWaitMs: 2_000,
    totalTimeoutMs: 5_000,
    clickTimeoutMs: 400,
    closeTimeoutMs: 700,
    readTimeoutMs: 1_000,
    pollIntervalMs: 30,
};
const zero = { orderClicks: 0, dismissClicks: 0, infoClicks: 0, otherClicks: 0, termsChanges: 0 };
async function withPage(
    mode: Mode,
    run: (page: Page, requests: () => number) => Promise<void>,
    html?: string,
    closeMode?: string,
) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const requests = await installSubmission(page, mode, html, closeMode);
        await run(page, requests);
    } finally {
        await browser.close();
    }
}
async function failure(promise: Promise<unknown>): Promise<TicketPlusSubmissionError> {
    try {
        await promise;
    } catch (error) {
        assert(error instanceof TicketPlusSubmissionError);
        return error;
    }
    assert.fail("應停止而非成功");
}
const submit = (page: Page, overrides: TicketSubmissionOptions = {}) =>
    submitTicketPlusSelection(page, settings, selection, { ...options, ...overrides });

// 只觀察真實 click 的呼叫開始，不替換執行結果；瀏覽器仍自行做 actionability 等待。
async function observeClick(
    testContext: TestContext,
    page: Page,
    attempt: number,
): Promise<{ started: Promise<void> }> {
    const handle = await page.locator("button").first().elementHandle();
    assert(handle);
    const prototype = Object.getPrototypeOf(handle) as { click: typeof handle.click };
    const original = prototype.click;
    let announce!: () => void;
    const started = new Promise<void>(resolve => {
        announce = resolve;
    });
    let calls = 0;
    testContext.mock.method(
        prototype,
        "click",
        function (this: ElementHandle<HTMLElement>, ...args: Parameters<typeof original>) {
            const action = original.apply(this, args);
            if (++calls === attempt) announce();
            return action;
        },
    );
    await handle.dispose();
    return { started };
}

test("TicketPlus 提交：直接抵達同場次資料頁，資料頁下一步可按也零操作", async () => {
    await withPage("direct", async (page, requests) => {
        const result = await submit(page);
        assert.equal(result.kind, "information");
        assert.equal(result.sessionId, "session-B");
        assert.equal(result.nextEnabled, true);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        assert.equal(requests(), 1);
    });
});

test("TicketPlus 提交：票種列 class 不同時，仍以同一套找列規則確認目標列後送出一次", async () => {
    await withPage("direct", async page => {
        await page.evaluate(() => {
            document.querySelectorAll(".rwd-margin").forEach(row => {
                row.className = "ticket-line";
            });
        });
        const result = await submit(page);
        assert.equal(result.kind, "information");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交：排隊消失回選票再排隊，直到資料頁才完成", async () => {
    await withPage("queue", async (page, requests) => {
        let finished = false;
        const result = submit(page).finally(() => {
            finished = true;
        });
        await page.waitForFunction(
            () => window.submissionFixture.orderClicks === 1 && window.submissionFixture.reads >= 4,
        );
        assert.equal(finished, false);
        await page.evaluate(() => {
            window.submissionFixture.show("order");
            window.submissionFixture.reads = 0;
        });
        await page.waitForFunction(() => window.submissionFixture.reads >= 2);
        assert.equal(finished, false);
        await page.evaluate(() => {
            window.submissionFixture.show("queue");
            window.submissionFixture.reads = 0;
        });
        await page.waitForFunction(() => window.submissionFixture.reads >= 2);
        await page.evaluate(() => window.submissionFixture.show("information"));
        assert.equal((await result).kind, "information");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        assert.equal(requests(), 1);
    });
});

test("TicketPlus 提交：售完／失敗／限購各關閉一次，關閉後停止不重送", { timeout: 20_000 }, async () => {
    for (const [message, category] of [
        ["購票失敗：您選擇的票種已售完", "sold-out"],
        ["購票失敗", "purchase-failed"],
        ["本活動有限制購票總張數", "purchase-failed"],
    ] as const) {
        await withPage(
            "failure",
            async (page, requests) => {
                const error = await failure(submit(page));
                assert.equal(error.reason, "order-rejected");
                assert.equal(error.progress.failure, category);
                assert.equal(error.progress.dismissal, "confirmed");
                assert.equal(error.progress.dismissAttempted, true);
                await page.evaluate(() => window.submissionFixture.show("information"));
                await page.waitForTimeout(100);
                assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1, dismissClicks: 1 });
                assert.equal(requests(), 1);
                assert(!error.message.includes(message));
            },
            failureDialog(message),
        );
    }
});

test("TicketPlus 提交：排隊與失敗同時出現，失敗優先且只關一次", async () => {
    await withPage(
        "failure",
        async page => {
            const error = await failure(submit(page));
            assert.equal(error.progress.failure, "sold-out");
            assert.equal(error.progress.dismissal, "confirmed");
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1, dismissClicks: 1 });
        },
        queueDialog + failureDialog(),
    );
});

test("TicketPlus 提交：背景售完、隱藏舊彈窗和空外框不阻擋", async () => {
    await withPage("direct", async page => {
        await page
            .locator("body")
            .evaluate(
                (body, html) => body.insertAdjacentHTML("beforeend", html),
                `<div class="v-dialog__content"><div hidden>${failureDialog()}</div></div><div class="v-dialog"></div>`,
            );
        assert.equal((await submit(page)).kind, "information");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交：既存失敗、錯票數、額外票、錯場次與重複下一步皆零操作", { timeout: 20_000 }, async () => {
    for (const kind of ["failure", "quantity", "extra", "wrong", "duplicate", "disabled"]) {
        await withPage("direct", async page => {
            await page.evaluate(
                ({ kind, dialog }) => {
                    if (kind === "failure") document.body.insertAdjacentHTML("beforeend", dialog);
                    if (kind === "wrong") history.replaceState({}, "", "/order/event-fixture/wrong");
                    if (kind === "quantity") document.querySelectorAll(".count-button > div")[1]!.textContent = "1";
                    if (kind === "extra") document.querySelector(".count-button > div")!.textContent = "1";
                    if (kind === "duplicate") document.body.insertAdjacentHTML("beforeend", "<button>下一步</button>");
                    if (kind === "disabled")
                        Array.from(document.querySelectorAll("button")).find(
                            b => b.textContent === "下一步",
                        )!.disabled = true;
                },
                { kind, dialog: failureDialog() },
            );
            const error = await failure(submit(page));
            assert.equal(error.progress.submitAttempted, false);
            assert.deepEqual(await submissionCounts(page), zero);
        });
    }
});

test("TicketPlus 提交：未知文案、兩個彈窗、不明附加彈窗都不關", { timeout: 20_000 }, async () => {
    for (const html of [
        failureDialog("系統忙碌，請稍候"),
        failureDialog("個人資料不完整"),
        failureDialog() + failureDialog(),
        failureDialog() + failureDialog("另一個問題"),
    ]) {
        await withPage(
            "failure",
            async page => {
                const error = await failure(submit(page));
                assert.equal(error.reason, "unexpected-page");
                assert.equal(error.progress.failure, undefined);
                assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
            },
            html,
        );
    }
});

test("TicketPlus 提交：關閉鈕缺漏、模糊名稱、停用或歧義不猜著按", { timeout: 20_000 }, async () => {
    for (const html of [
        failureDialog().replace(/<button.*?<\/button>/, ""),
        failureDialog("已售完", "確定購買"),
        failureDialog().replace("<button", "<button disabled"),
        failureDialog().replace("</button>", "</button><button>確定</button>"),
    ]) {
        await withPage(
            "failure",
            async page => {
                const error = await failure(submit(page));
                assert.equal(error.reason, "dismiss-unavailable");
                assert.equal(error.progress.failure, "sold-out");
                assert.equal(error.progress.dismissAttempted, false);
                assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
            },
            html,
        );
    }
});

test("TicketPlus 提交：關閉後彈窗仍在或重建，不補按；導資料頁也不改報成功", { timeout: 15_000 }, async () => {
    for (const mode of ["stay", "replace", "navigate"]) {
        await withPage(
            "failure",
            async (page, requests) => {
                const error = await failure(submit(page, { closeTimeoutMs: 250 }));
                assert.equal(error.progress.failure, "sold-out");
                assert.equal(error.progress.dismissAttempted, true);
                assert.equal(error.progress.dismissal, "unconfirmed");
                await page.evaluate(() => window.submissionFixture.show("information"));
                await page.waitForTimeout(80);
                assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1, dismissClicks: 1 });
                assert.equal(requests(), 1);
            },
            failureDialog(),
            mode,
        );
    }
});

test("TicketPlus 提交：初始與排隊逾時後晚到資料頁，也不重送", async () => {
    for (const mode of ["stay", "queue"] as const) {
        await withPage(mode, async (page, requests) => {
            const error = await failure(submit(page, { submitWaitMs: 250, queueWaitMs: 250 }));
            assert.equal(error.progress.submitAttempted, true);
            assert.equal(error.progress.sawQueue, mode === "queue");
            await page.evaluate(() => window.submissionFixture.show("information"));
            await page.waitForTimeout(80);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
            assert.equal(requests(), 1);
        });
    }
});

test("TicketPlus 提交：最後核對後換成可按的資料頁，不能重定位下一步", async () => {
    await withPage("direct", async page => {
        await page.evaluate(information => {
            const title = document.querySelector<HTMLElement>(".text-page-title")!;
            const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!.get!;
            let reads = 0;
            Object.defineProperty(title, "innerText", {
                configurable: true,
                get() {
                    if (++reads === 2)
                        queueMicrotask(() => {
                            history.replaceState({}, "", "/confirm/event-fixture/session-B");
                            document.body.innerHTML = information;
                        });
                    return getter.call(title);
                },
            });
        }, readyInformation);
        await failure(submit(page));
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交：錯場次空白頁、資料頁加失敗、付款頁皆停止", async () => {
    for (const destination of ["wrong", "conflict", "checkout"]) {
        await withPage("queue", async page => {
            const result = failure(submit(page));
            await page.waitForFunction(() => window.submissionFixture.reads >= 4);
            await page.evaluate(
                ({ destination, information, dialog }) => {
                    history.replaceState(
                        {},
                        "",
                        destination === "wrong"
                            ? "/confirm/event-fixture/wrong"
                            : destination === "checkout"
                              ? "/checkout/event-fixture/session-B"
                              : "/confirm/event-fixture/session-B",
                    );
                    document.body.innerHTML = destination === "conflict" ? information + dialog : "";
                },
                { destination, information: readyInformation, dialog: failureDialog() },
            );
            const error = await result;
            assert.equal(error.progress.dismissAttempted, false);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus reader：失敗只回固定分類，未知訊息不帶出個資", async () => {
    await withPage("stay", async page => {
        await page
            .locator("body")
            .evaluate(
                (body, html) => body.insertAdjacentHTML("beforeend", html),
                failureDialog("秘密電話0900123456 購票失敗"),
            );
        const result = await readTicketPlusPage(page);
        assert.deepEqual(result, { kind: "unknown", reason: "blocking-dialog" });
        assert(!JSON.stringify(result).includes("0900123456"));
        await assert.rejects(selectTicketPlusTickets(page, settings, selection));
        await assert.rejects(selectTicketPlusSession(page, settings));
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交：排隊反覆出現不延長期限，總上限也能提前停止", async () => {
    await withPage("queue", async page => {
        let settled = false;
        const result = failure(submit(page, { queueWaitMs: 500, submitWaitMs: 1_000, totalTimeoutMs: 3_000 })).then(
            error => {
                settled = true;
                return error;
            },
        );
        await page.waitForFunction(() => window.submissionFixture.reads >= 4);
        const queueObservedAt = performance.now();
        let turn = 0;
        // 持續切換超過原排隊期限；若每次 queue 重設期限，900ms 時仍未停止。
        while (!settled && performance.now() - queueObservedAt < 900) {
            const phase: "queue" | "order" = turn++ % 2 ? "queue" : "order";
            await page.evaluate(phase => window.submissionFixture.show(phase), phase);
            await Promise.race([result, page.waitForTimeout(80)]);
        }
        assert.equal(settled, true, "排隊重現不得延長第一次建立的期限");
        const error = await result;
        assert.equal(error.progress.sawQueue, true);
        assert(performance.now() - queueObservedAt < 900);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
    await withPage("queue", async page => {
        const error = await failure(submit(page, { queueWaitMs: 5_000, totalTimeoutMs: 400 }));
        assert.equal(error.progress.sawQueue, true);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交：同路徑暫缺資料可等，資料頁缺聯絡欄位不冒稱驗證完成", async () => {
    await withPage("queue", async page => {
        const pending = submit(page);
        await page.waitForFunction(() => window.submissionFixture.reads >= 4);
        await page.evaluate(() => window.submissionFixture.show("unknown"));
        await page.waitForTimeout(80);
        await page.evaluate(() => {
            window.submissionFixture.show("information");
            document.querySelector<HTMLInputElement>('input[id="fixture-phone"]')!.remove();
        });
        const result = await pending;
        assert.equal(result.contactFields.phone.present, false);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交：關閉自動等待期間換成陌生彈窗，不能改按新確定", async testContext => {
    await withPage(
        "failure",
        async page => {
            const { started } = await observeClick(testContext, page, 2);
            const pending = failure(submit(page, { closeTimeoutMs: 1_500, clickTimeoutMs: 800 }));
            await Promise.race([started, pending.then(() => assert.fail("尚未進入關閉 click"))]);
            await page.evaluate(() => {
                document.querySelector(".v-dialog__content")!.outerHTML =
                    '<div role="dialog"><p>確認付款</p><button data-fixture="other">確定</button></div>';
                document.querySelector('[data-fixture="cover"]')?.remove();
            });
            const error = await pending;
            assert.equal(error.progress.failure, "sold-out");
            assert.notEqual(error.progress.dismissal, "confirmed");
            assert.equal(error.progress.dismissAttempted, true);
            await page.waitForTimeout(100);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        },
        failureDialog("購票失敗", "確定").replace("購票失敗", "已售完") +
            '<div data-fixture="cover" style="position:fixed;inset:0;z-index:999;background:white"></div>',
    );
});

test("TicketPlus 提交：提交被遮罩擋住後逾時，解除遮罩也不遲到點擊", async () => {
    await withPage("direct", async page => {
        await page
            .locator("body")
            .evaluate(body =>
                body.insertAdjacentHTML(
                    "beforeend",
                    '<div data-fixture="cover" style="position:fixed;inset:0;z-index:999;background:white"></div>',
                ),
            );
        const error = await failure(submit(page, { clickTimeoutMs: 100 }));
        assert.equal(error.reason, "submit-click-failed");
        assert.equal(error.progress.submitAttempted, true);
        await page.locator('[data-fixture="cover"]').evaluate(element => element.remove());
        await page.waitForTimeout(120);
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交：讀取超過期限後不得接著操作", async () => {
    await withPage("direct", async page => {
        await page.evaluate(() => {
            const title = document.querySelector<HTMLElement>(".text-page-title")!;
            const original = title.innerText;
            Object.defineProperty(title, "innerText", {
                configurable: true,
                get() {
                    const end = performance.now() + 250;
                    while (performance.now() < end) {
                        /* 本機 fixture 模擬繁忙 renderer。 */
                    }
                    return original;
                },
            });
        });
        const error = await failure(submit(page, { readTimeoutMs: 50 }));
        assert.equal(error.reason, "read-timeout");
        assert.equal(error.progress.submitAttempted, false);
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交：無效設定、快照與期限在瀏覽器操作前拒絕", async () => {
    await withPage("direct", async page => {
        for (const timeout of [0, -1, Infinity, NaN]) {
            const error = await failure(submit(page, { queueWaitMs: timeout }));
            assert.equal(error.reason, "invalid-options");
        }
        await failure(submitTicketPlusSelection(page, settings, { ...selection, sessionId: "" }, options));
        await failure(
            submitTicketPlusSelection(
                page,
                { ...settings, target: { ...settings.target, quantity: 1 } },
                selection,
                options,
            ),
        );
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus reader：透明祖先與未知原型名稱不當失敗，既有張數遇失敗零操作", async () => {
    await withPage("stay", async page => {
        await page.setContent(readyOrder + `<div style="opacity:0">${failureDialog()}</div>`);
        assert.equal((await readTicketPlusPage(page)).kind, "ticket-selection");
        await page.setContent(readyOrder + failureDialog("constructor"));
        assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "blocking-dialog" });
        await page.setContent(readyOrder + failureDialog());
        const result = await readTicketPlusPage(page);
        assert.equal(result.kind, "order-failure");
        await assert.rejects(selectTicketPlusTickets(page, settings, selection));
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交：已開始 click 等待時換到資料頁，不改按其下一步", async testContext => {
    await withPage("direct", async page => {
        const { started } = await observeClick(testContext, page, 1);
        await page
            .locator("body")
            .evaluate(body =>
                body.insertAdjacentHTML(
                    "beforeend",
                    '<div style="position:fixed;inset:0;z-index:999;background:white"></div>',
                ),
            );
        const pending = failure(submit(page, { clickTimeoutMs: 800 }));
        await Promise.race([started, pending.then(() => assert.fail("尚未進入提交 click"))]);
        await page.evaluate(() => window.submissionFixture.show("information"));
        const error = await pending;
        assert.equal(error.progress.submitAttempted, true);
        assert.equal(error.reason, "submit-click-failed");
        assert.deepEqual(await submissionCounts(page), zero);
    });
});

test("TicketPlus 提交診斷：保留資料頁拒絕條件並傳到結果訊息，零重送", { timeout: 30_000 }, async () => {
    const cases = [
        { extra: '<div class="stepText checkedStep">付款結帳</div>', reason: "conflicting-page" },
        { extra: "<div>聯絡人資訊</div>", reason: "ambiguous-data" },
        { extra: '<div role="dialog">PRIVATE_DIALOG</div>', reason: "blocking-dialog" },
    ];
    for (const item of cases) {
        await withPage("direct", async page => {
            await page.evaluate(extra => {
                document.addEventListener("click", () => {
                    if (location.pathname.startsWith("/confirm/")) document.body.insertAdjacentHTML("beforeend", extra);
                });
            }, item.extra);
            const error = await failure(submit(page, { submitWaitMs: 300 }));
            if (item.reason === "ambiguous-data") assert(["wait-timeout", "read-timeout"].includes(error.reason));
            else assert.equal(error.reason, "unexpected-page");
            assert.equal(error.diagnostic?.phase, "after-submit");
            assert.equal(error.diagnostic?.page?.unknownReason, item.reason);
            assert.equal(error.diagnostic?.page?.informationControls?.nextButtons, 1);
            const result = stoppedSubmissionResult(error);
            assert.equal(result.outcome, "unknown");
            const message = ticketPlusResultMessage(result);
            assert(message.includes(error.reason));
            assert(message.includes(item.reason));
            assert.match(message, /不會重送/);
            assert.doesNotMatch(message, /PRIVATE_DIALOG|event-fixture|session-B|https:/);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus 提交診斷：缺漏資料逾時、排隊逾時與網址拒絕保留不同原因", { timeout: 20_000 }, async () => {
    await withPage("direct", async page => {
        await page.evaluate(() => {
            document.addEventListener("click", () =>
                document.querySelectorAll('input[type="checkbox"]').forEach(input => input.remove()),
            );
        });
        const error = await failure(submit(page, { submitWaitMs: 300 }));
        assert(["wait-timeout", "read-timeout"].includes(error.reason));
        assert.equal(error.diagnostic?.page?.unknownReason, "incomplete-data");
        assert.equal(error.diagnostic?.page?.markers?.terms, 0);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
    await withPage("queue", async page => {
        const error = await failure(submit(page, { queueWaitMs: 300 }));
        assert(["wait-timeout", "read-timeout"].includes(error.reason));
        assert.equal(error.progress.sawQueue, true);
        assert.equal(error.diagnostic?.page?.pageKind, "queue");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
    await withPage("direct", async page => {
        await page.evaluate(() => {
            document.addEventListener("click", () => history.replaceState({}, "", "?token=PRIVATE_TOKEN"));
        });
        const error = await failure(submit(page));
        assert.equal(error.reason, "unexpected-route");
        assert.equal(error.diagnostic?.routeFailure, "extra-url-parts");
        assert.equal(error.diagnostic?.page, undefined);
        assert.doesNotMatch(JSON.stringify(stoppedSubmissionResult(error)), /PRIVATE_TOKEN/);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 含摘要的資料頁：直接及排隊後皆完成，零資料頁操作", { timeout: 20_000 }, async () => {
    for (const mode of ["direct", "queue"] as const) {
        await withPage(mode, async page => {
            await page.evaluate(summary => {
                document.addEventListener("click", () => {
                    if (location.pathname.startsWith("/confirm/"))
                        document.body.insertAdjacentHTML("beforeend", summary);
                });
            }, summary);
            class QueueControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    await page.evaluate(summary => {
                        window.submissionFixture.show("information");
                        document.body.insertAdjacentHTML("beforeend", summary);
                    }, summary);
                    await super.wait(milliseconds);
                }
            }
            const result = await runTicketPlusSubmission(
                page,
                settings,
                selection,
                options,
                undefined,
                new QueueControl(),
            );
            assert.equal(result.outcome, "information-ready");
            assert.equal(result.progress.sawQueue, mode === "queue");
            assert.match(ticketPlusResultMessage(result), /已到同場次填寫資料頁/);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus 含摘要的資料頁：錯場次仍拒絕且不重送", async () => {
    await withPage("direct", async page => {
        await page.evaluate(summary => {
            document.addEventListener("click", () => {
                document.body.insertAdjacentHTML("beforeend", summary);
                history.replaceState({}, "", "/confirm/event-fixture/session-WRONG");
            });
        }, summary);
        const error = await failure(submit(page));
        assert.equal(error.reason, "unexpected-route");
        assert.equal(stoppedSubmissionResult(error).outcome, "unknown");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

// 模擬網站先改成資料頁網址，畫面暫時保留已提交的選票內容。
async function installConfirmTransition(page: Page, html = readyOrder): Promise<void> {
    await page.evaluate(html => {
        document.addEventListener(
            "click",
            () => {
                history.replaceState({}, "", "/confirm/event-fixture/session-B");
                document.body.innerHTML = html;
            },
            { once: true },
        );
    }, html);
}

test("TicketPlus 提交過渡：同場次選票殘留到資料頁，只提交一次", { timeout: 15_000 }, async () => {
    await withPage("stay", async page => {
        await installConfirmTransition(page);
        let waits = 0;
        class TransitionControl extends TicketPlusRunControl {
            override async wait(milliseconds: number): Promise<void> {
                waits++;
                if (waits === 1) {
                    assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
                    await page.setContent("<main>載入中</main>");
                } else {
                    await page.evaluate(() => window.submissionFixture.show("information"));
                }
                await super.wait(milliseconds);
            }
        }
        const result = await runTicketPlusSubmission(
            page,
            settings,
            selection,
            options,
            undefined,
            new TransitionControl(),
        );
        assert.equal(result.outcome, "information-ready");
        assert.equal(waits, 2);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交過渡：排隊後的殘留仍沿用期限，逾時保留診斷", { timeout: 15_000 }, async () => {
    await withPage("queue", async page => {
        let waits = 0;
        class TransitionControl extends TicketPlusRunControl {
            override async wait(milliseconds: number): Promise<void> {
                if (++waits === 1) {
                    await page.evaluate(() => {
                        window.submissionFixture.show("order");
                        history.replaceState({}, "", "/confirm/event-fixture/session-B");
                    });
                }
                await super.wait(milliseconds);
            }
        }
        const started = performance.now();
        const result = await runTicketPlusSubmission(
            page,
            settings,
            selection,
            { ...options, queueWaitMs: 300, submitWaitMs: 4_000 },
            undefined,
            new TransitionControl(),
        );
        assert.equal(result.outcome, "unknown");
        assert("reason" in result);
        // 截止可能落在輪詢等待或最後一次唯讀讀取，兩者都不得延長期限。
        assert(["wait-timeout", "read-timeout"].includes(result.reason));
        assert.equal(result.progress.sawQueue, true);
        assert.equal(result.diagnostic?.page?.routeKind, "confirm");
        assert.equal(result.diagnostic?.page?.unknownReason, "conflicting-page");
        assert.deepEqual(result.diagnostic?.page?.readiness, { status: "pending", reason: "information-not-ready" });
        assert(performance.now() - started < 2_000);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交過渡：活動、票種、張數不符及危險畫面仍立即停止", { timeout: 30_000 }, async () => {
    const mismatches = [
        readyOrder.replace(settings.eventName, "其他活動"),
        readyOrder.replace("2026-10-30", "2026-10-31"),
        readyOrder.replace("20:00", "21:00"),
        readyOrder.replace("預售票", "其他票種"),
        readyOrder.replace("<div>2</div>", "<div>1</div>"),
        readyOrder.replace("<div>0</div>", "<div>1</div>"),
        readyOrder + presale,
    ];
    const blockers = [
        readyOrder + queueDialog,
        readyOrder + '<div role="dialog">提示</div>',
        readyOrder + "<button>前往付款</button>",
        readyOrder + '<div class="stepText checkedStep">付款結帳</div>',
    ];
    const cases = [
        ...mismatches
            .flatMap(html => [html, html + "<div>聯絡人資訊</div>" + summary])
            .map(html => ({ html, reason: "selection-mismatch" })),
        ...blockers.map(html => ({ html, reason: "unexpected-page" })),
    ];
    for (const { html, reason } of cases) {
        await withPage("stay", async page => {
            await installConfirmTransition(page, html);
            let waits = 0;
            class ObservedControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    waits++;
                    await super.wait(milliseconds);
                }
            }
            const result = await runTicketPlusSubmission(
                page,
                settings,
                selection,
                options,
                undefined,
                new ObservedControl(),
            );
            assert.equal(result.outcome, "unknown");
            assert("reason" in result);
            assert.equal(result.reason, reason);
            assert.equal(waits, 0);
            assert.doesNotMatch(JSON.stringify(result.diagnostic), /PRIVATE_CONTACT|其他活動|session-B/);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus 提交過渡：可手動停止，晚到錯場次仍拒絕", { timeout: 15_000 }, async () => {
    for (const stop of [true, false]) {
        await withPage("stay", async page => {
            await installConfirmTransition(page);
            const controller = new AbortController();
            class TransitionControl extends TicketPlusRunControl {
                override async wait(milliseconds: number): Promise<void> {
                    if (stop) controller.abort();
                    else
                        await page.evaluate(() => {
                            window.submissionFixture.show("information");
                            history.replaceState({}, "", "/confirm/event-fixture/session-WRONG");
                        });
                    await super.wait(milliseconds);
                }
            }
            const result = await runTicketPlusSubmission(
                page,
                settings,
                selection,
                options,
                undefined,
                new TransitionControl(controller.signal),
            );
            assert.equal(result.outcome, "unknown");
            assert("reason" in result);
            assert.equal(result.reason, stop ? "user-stopped" : "unexpected-route");
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus 提交過渡：排隊結束後殘留選票，再抵達資料頁", async () => {
    await withPage("queue", async page => {
        let waits = 0;
        class TransitionControl extends TicketPlusRunControl {
            override async wait(milliseconds: number): Promise<void> {
                if (++waits === 1) {
                    await page.evaluate(() => {
                        window.submissionFixture.show("order");
                        history.replaceState({}, "", "/confirm/event-fixture/session-B");
                    });
                } else {
                    assert.deepEqual(await readTicketPlusPage(page), { kind: "unknown", reason: "conflicting-page" });
                    await page.evaluate(() => window.submissionFixture.show("information"));
                }
                await super.wait(milliseconds);
            }
        }
        const result = await runTicketPlusSubmission(
            page,
            settings,
            selection,
            options,
            undefined,
            new TransitionControl(),
        );
        assert.equal(result.outcome, "information-ready");
        assert.equal(result.progress.sawQueue, true);
        assert.equal(waits, 2);
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
    });
});

test("TicketPlus 提交等待：殘缺票數與資料重疊到期限，不重送", { timeout: 15_000 }, async () => {
    for (const html of [
        readyOrder.replace("<div>2</div>", "<div>?</div>"),
        readyOrder + "<div>聯絡人資訊</div>",
        readyOrder + '<label>姓名<input value="PRIVATE_CONTACT"></label>',
        readyOrder + summary,
    ]) {
        await withPage("stay", async page => {
            await installConfirmTransition(page, html);
            const error = await failure(submit(page, { submitWaitMs: 300 }));
            assert(["wait-timeout", "read-timeout"].includes(error.reason));
            assert.deepEqual(error.diagnostic?.page?.readiness, { status: "pending", reason: "information-not-ready" });
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        });
    }
});

test("TicketPlus 提交等待：獨立回應讓選票與資料重疊結束，資料頁零操作", { timeout: 15_000 }, async () => {
    await withPage("stay", async page => {
        let release!: () => void;
        let requested!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const request = new Promise<void>(resolve => {
            requested = resolve;
        });
        await page.route("**/information-content", async route => {
            requested();
            await gate;
            await route.fulfill({ contentType: "text/html; charset=utf-8", body: readyInformation });
        });
        await installConfirmTransition(page, readyOrder + "<div>聯絡人資訊</div>" + summary);
        await page.evaluate(() => {
            document.addEventListener(
                "click",
                () => {
                    void fetch("/information-content")
                        .then(response => response.text())
                        .then(html => {
                            document.body.innerHTML = html;
                        });
                },
                { once: true },
            );
        });
        let settled = false;
        const outcome = submit(page).then(
            value => {
                settled = true;
                return { value };
            },
            error => {
                settled = true;
                return { error };
            },
        );
        try {
            await Promise.race([
                request,
                outcome.then(result => {
                    if ("error" in result) throw result.error;
                    assert.fail("網站回應尚未放行卻提早完成");
                }),
            ]);
            await delay(250);
            assert.equal(settled, false);
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
            release();
            const result = await outcome;
            if ("error" in result) throw result.error;
            assert.equal(result.value.kind, "information");
            assert.equal(result.value.sessionId, "session-B");
            assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        } finally {
            release();
            await outcome;
        }
    });
});

test("TicketPlus 提交：抽選排隊彈窗等待後抵達資料頁，只送出一次", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        const requests = await installSubmission(page, "queue", undefined, undefined, lotteryQueueDialog);
        const result = submit(page);
        await page.waitForFunction(
            () => window.submissionFixture.orderClicks === 1 && window.submissionFixture.reads >= 3,
        );
        await page.evaluate(() => window.submissionFixture.show("information"));
        assert.equal((await result).kind, "information");
        assert.deepEqual(await submissionCounts(page), { ...zero, orderClicks: 1 });
        assert.equal(requests(), 1);
    } finally {
        await browser.close();
    }
});
