import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { KlookTicketSelector } from "../src/platforms/klook/ticketSelector.js";
import { KlookTargetAttempt } from "../src/platforms/klook/targetAttempt.js";
import { KlookQueueRecovery } from "../src/platforms/klook/expiryRecovery.js";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";

const url = fixtureConfig.eventUrl;
const group = (name: string, value: string) =>
    `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div><div class="spec-LwNjSh active-vB3nra">${value}</div></div></div>`;
const options =
    group("日期", "10月3日(週六)") +
    group("時間", "12:00") +
    group("票種", "A區 NT$4880") +
    '<div class="eventUnit-kxDycC"><div class="value-xWKzpL">1</div>最多4張</div>';
const panel = `<div class="main_right-ZMnX67"><div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午12:00</span></div><div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">A區 NT$4880</div><div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>A1</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>15</ins></span></div></div><div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$4880</div></div><button onclick="document.body.dataset.confirm=1">確認</button></div>`;

function fixture(mode: string): string {
    return `<div id="ticket-options"><button>重新整理</button><div id="options"></div><button id="next">下一步</button></div>
    <script>
    var okClicks = 0, nextClicks = 0;
    function showNotice() {
        const dialog = document.createElement('div'); dialog.className='klk-modal-alert';
        dialog.innerHTML = '<p>${mode === "unknown" ? "請稍後再試" : "抱歉，時間到了！ 請返回並重新排隊"}</p><button>OK</button>';
        dialog.querySelector('button').onclick = () => {
            document.body.dataset.ok = String(++okClicks);
            if (${JSON.stringify(mode)} === 'failed-return') return;
            dialog.remove();
            document.querySelector('#options').innerHTML = ${JSON.stringify(mode === "twice" ? group("時間", "12:00") : options)};
            if (${JSON.stringify(mode)} === 'twice') setTimeout(showNotice, 100);
        };
        document.body.append(dialog);
        if (${JSON.stringify(mode)} === 'multiple') document.body.append(dialog.cloneNode(true));
    }
    document.querySelector('#next').onclick = () => { document.body.dataset.next=String(++nextClicks); document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(panel)}); };

    </script>`;
}

test("等待日期途中才排隊過期：恢復一次重選同順位；額度耗盡、未知或返回失敗不重試", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route =>
            route.fulfill({ body: "<body></body>", contentType: "text/html; charset=utf-8" }),
        );
        for (const mode of ["success", "twice", "unknown", "multiple", "failed-return", "absent"]) {
            await page.goto(url);
            await page.setContent(fixture(mode));
            // 在日期輪詢第一次等待時才出現提示，避免計時器在初始檢查前觸發。
            const originalWait = page.waitForTimeout.bind(page);
            let injected = false;
            page.waitForTimeout = async milliseconds => {
                if (!injected && mode !== "absent") {
                    injected = true;
                    await page.evaluate("showNotice()");
                }
                await originalWait(milliseconds);
            };
            const strategy = new PriorityStrategy({
                ...fixtureConfig,
                targets: [fixtureConfig.targets[0]!, { ...fixtureConfig.targets[0]!, area: "B區" }],
            });
            const adapter = new KlookTargetAttempt(page, url, 800);
            const queue = new KlookQueueRecovery(page, url, 500);
            const contact = {
                isRequired: async () => false,
                recover: async () => {
                    assert.fail("不能借用預留額度");
                },
            };
            const run = prepareBooking(
                {
                    selectSeats: () => strategy.select(adapter),
                    confirmSeats: async () => {},
                    prepareContact: async () => {},
                },
                queue,
                contact,
            );
            if (mode === "success") {
                assert.equal((await run).target.area, "A區");
                assert.equal(await page.locator("body").getAttribute("data-next"), "1");
            } else {
                await assert.rejects(
                    run,
                    mode === "twice" ? /恢復上限/ : mode === "failed-return" ? /未能確認活動頁恢復/ : PurchaseStop,
                );
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
            }
            assert.equal(
                await page.locator("body").getAttribute("data-ok"),
                ["success", "twice", "failed-return"].includes(mode) ? "1" : null,
            );
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
            page.waitForTimeout = originalWait;
        }
    } finally {
        await browser.close();
    }
});

test("真實 adapter 保留價格不符停止，即使錯誤發生時同時出現過期提示", async t => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.route("**/*", route =>
            route.fulfill({ body: "<body></body>", contentType: "text/html; charset=utf-8" }),
        );
        await page.goto(url);
        await page.setContent(fixture("success"));
        const mismatch = new PurchaseStop("票種單價不符，已停止。");
        // 固定競態發生點：驗證已失敗，例外離開 selector 時才有過期提示。
        t.mock.method(KlookTicketSelector.prototype, "selectAndVerify", async () => {
            await page.evaluate("showNotice()");
            throw mismatch;
        });
        const adapter = new KlookTargetAttempt(page, url, 500);
        const strategy = new PriorityStrategy(fixtureConfig);
        await assert.rejects(
            prepareBooking(
                {
                    selectSeats: () => strategy.select(adapter),
                    confirmSeats: async () => {
                        assert.fail("不應確認座位");
                    },
                    prepareContact: async () => {
                        assert.fail("不應填寫資料");
                    },
                },
                new KlookQueueRecovery(page, url, 500),
                {
                    isRequired: async () => false,
                    recover: async () => {
                        assert.fail("不應恢復");
                    },
                },
            ),
            error => error === mismatch,
        );
        assert.equal(await page.locator("body").getAttribute("data-ok"), null);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await browser.close();
    }
});
