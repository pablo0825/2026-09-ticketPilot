import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { chromium, type Page } from "playwright";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { KlookQueueRecovery } from "../src/platforms/klook/expiryRecovery.js";
import { prepareStartup } from "../src/platforms/klook/startup.js";
import { validateSaleSchedule } from "../src/core/purchaseValidation.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/sale-fixture/";
const saleAt = "2026-10-10T10:00:00+08:00";
const sale = Date.parse(saleAt);
const logged = '<nav class="default-header"><div class="default-header_logged-in"><button class="default-header_avatar">avatar</button></div></nav>';
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh disabled-ImixBj">B區</div><button onclick="document.body.dataset.clicked=1">下一步</button></div>';
const coming = '<div id="ticket-options"><div class="package-wrapper stateText">即將開賣</div></div>';
const queue = '<div class="klk-modal-alert"><p>抱歉，時間到了！ 請返回並重新排隊</p><button onclick="document.body.dataset.clicked=1">OK</button></div>';

test("排程設定拒絕錯誤日期、缺少時區及不支援的提前量", () => {
    assert.equal(validateSaleSchedule({ saleAt }), sale);
    for (const value of ["2026-02-30T10:00:00+08:00", "2026-10-10T10:00:00", "2026-10-10T24:00:00+08:00", "bad"]) {
        assert.throws(() => validateSaleSchedule({ saleAt: value }));
    }
    assert.throws(() => validateSaleSchedule({ saleAt, advanceSeconds: 0 as 1 }));
});

// 虛擬時鐘只推進排程時間；DOM 與導覽仍由真實 Chromium + 攔截頁面驗證。
async function scenario(run: (page: Page, clock: { now: number }, visits: number[]) => Promise<void>,
    event: (visit: number, clock: { now: number }) => { body: string; status?: number }, start = sale - 5000) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const clock = { now: start };
    const visits: number[] = [];
    const timer = mock.method(Date, "now", () => clock.now);
    page.waitForTimeout = async milliseconds => { clock.now += milliseconds; };
    try {
        await page.route("**/*", async route => {
            let result = { body: logged };
            if (route.request().url() === eventUrl) {
                visits.push(clock.now);
                result = event(visits.length, clock);
            }
            await route.fulfill({ contentType: "text/html; charset=utf-8", ...result });
        });
        await run(page, clock, visits);
        if (!page.isClosed()) assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
    } finally { timer.mock.restore(); await browser.close(); }
}
const options = { saleSchedule: { saleAt }, pollInterval: 500 };

test("提前一秒刷新一次；選項已出現仍等正式開賣，停用選項交原策略", async () => {
    await scenario(async (page, clock, visits) => {
        assert.equal(await prepareStartup(page, eventUrl, options), "ready");
        assert.deepEqual(visits, [sale - 5000, sale - 1000]);
        assert.equal(clock.now, sale);
        clock.now = sale + 180_000;
        assert.equal(visits.length, 2); // 已返回，沒有背景刷新或截止工作。
    }, visit => ({ body: logged + (visit === 1 ? coming : tickets) }));
});

test("新頁仍即將開賣：三秒間隔包含提前那次刷新", async () => {
    await scenario(async (page, clock, visits) => {
        assert.equal(await prepareStartup(page, eventUrl, options), "ready");
        assert.deepEqual(visits, [sale - 5000, sale - 1000, sale + 2000]);
        assert.equal(clock.now, sale + 2000);
    }, visit => ({ body: logged + (visit < 3 ? coming : tickets) }));
});

test("慢導航仍保留舊即將開賣 DOM，不會重複刷新", async () => {
    await scenario(async (page, clock, visits) => {
        assert.equal(await prepareStartup(page, eventUrl, options), "ready");
        assert.equal(clock.now, sale + 8000);
        assert.equal(visits.length, 2);
    }, (visit, clock) => {
        if (visit === 2) clock.now += 9000;
        return { body: logged + (visit === 1 ? coming : tickets) };
    });
});

test("導航與空白 DOM 共用六十秒，不重刷、不各等六十秒", async () => {
    await scenario(async (page, clock, visits) => {
        await assert.rejects(prepareStartup(page, eventUrl, options), /載入逾時/);
        assert.equal(clock.now, sale - 1000 + 60_000);
        assert.equal(visits.length, 2);
    }, (visit, clock) => {
        if (visit === 2) clock.now += 40_000;
        return { body: logged + (visit === 1 ? coming : '<div id="ticket-options"></div>') };
    });
});

test("新頁 DOM 延遲完成：等同一次載入，沒有多餘刷新", async () => {
    await scenario(async (page, clock, visits) => {
        page.waitForTimeout = async ms => {
            clock.now += ms;
            if (visits.length === 2 && clock.now >= sale + 2000) await page.setContent(logged + tickets);
        };
        assert.equal(await prepareStartup(page, eventUrl, options), "ready");
        assert.equal(visits.length, 2);
    }, visit => ({ body: logged + (visit === 1 ? coming : '<div id="ticket-options"></div>') }));
});

test("開賣前排隊逾期保留彈窗，到點交原恢復，不刷新也不按 OK", async () => {
    await scenario(async (page, clock, visits) => {
        assert.equal(await prepareStartup(page, eventUrl, options), "queue-expired");
        assert.equal(clock.now, sale);
        assert.equal(visits.length, 1);
    }, () => ({ body: logged + coming + queue }));
});

test("刷新 403、未知彈窗與矛盾狀態停止，不再刷新", async () => {
    for (const result of [
        { body: logged, status: 403 },
        { body: logged + '<div role="dialog">未知提示</div>' },
        { body: logged + coming.replace('</div></div>', '<div class="spec-LwNjSh">B區</div></div></div>') },
    ]) {
        await scenario(async (page, _clock, visits) => {
            await assert.rejects(prepareStartup(page, eventUrl, options));
            assert.equal(visits.length, 2);
        }, visit => visit === 1 ? { body: logged + coming } : result);
    }
});

test("持續即將開賣固定兩分鐘截止；截止後啟動不導覽", async () => {
    await scenario(async (page, clock) => {
        await assert.rejects(prepareStartup(page, eventUrl, options), /截止|兩分鐘|逾時/);
        assert.equal(clock.now, sale + 120_000);
    }, () => ({ body: logged + coming }));
    await scenario(async (page, _clock, visits) => {
        await assert.rejects(prepareStartup(page, eventUrl, options), /截止/);
        assert.equal(visits.length, 0);
    }, () => ({ body: logged + coming }), sale + 120_000);
});

test("開賣後才啟動立即刷新；剩餘時間限制單次載入", async () => {
    await scenario(async (page, clock, visits) => {
        await assert.rejects(prepareStartup(page, eventUrl, options), /截止|两分鐘|兩分鐘|逾時/);
        assert.equal(clock.now, sale + 120_000);
        assert.equal(visits.length, 2);
    }, visit => ({ body: logged + (visit === 1 ? coming : '<div id="ticket-options"></div>') }), sale + 110_000);
});

test("開賣等待登出：手動登入不得延長截止", async () => {
    await scenario(async (page, clock, visits) => {
        await assert.rejects(prepareStartup(page, eventUrl, options), /登入等待逾時/);
        assert.equal(clock.now, sale + 120_000);
        assert.equal(visits.length, 2);
    }, visit => ({ body: visit === 1 ? logged + coming : '<nav class="default-header"><button class="default-header_signin">登入</button></nav>' }));
});

test("開賣前人工登入回到活動頁仍準時刷新；新排隊或選位不得被導覽蓋掉", async () => {
    const loggedOut = '<nav class="default-header"><button class="default-header_signin">登入</button></nav>';
    for (const afterLogin of [tickets, coming + queue, '<div class="seatModal">選位</div>']) {
        await scenario(async (page, clock, visits) => {
            let restored = false;
            page.waitForTimeout = async ms => {
                clock.now += ms;
                if (!restored) {
                    restored = true;
                    await page.setContent(logged + afterLogin);
                }
            };
            if (afterLogin.includes("seatModal")) {
                await assert.rejects(prepareStartup(page, eventUrl, options), /選位/);
                assert.equal(visits.length, 1);
            } else {
                assert.equal(await prepareStartup(page, eventUrl, options), afterLogin.includes("klk-modal") ? "queue-expired" : "ready");
                assert.equal(clock.now, sale);
                assert.deepEqual(visits, afterLogin.includes("klk-modal") ? [sale - 5000] : [sale - 5000, sale - 1000]);
            }
        }, visit => ({ body: visit === 1 ? loggedOut + coming : logged + tickets }));
    }
});

test("DOM 讀取跨過截止時間不得交棒選票", async () => {
    await scenario(async (page, clock, visits) => {
        const evaluate = page.evaluate.bind(page);
        page.evaluate = (async (...args: Parameters<Page["evaluate"]>) => {
            const result = await evaluate(...args);
            if (visits.length === 2) clock.now = sale + 120_001;
            return result;
        }) as Page["evaluate"];
        await assert.rejects(prepareStartup(page, eventUrl, options), /逾時/);
        assert.equal(visits.length, 2);
    }, () => ({ body: logged + tickets }));
});

test("queue 交棒實際恢復協調：只消耗原額度，重跑不啟動排程", async () => {
    await scenario(async (page, clock, visits) => {
        assert.equal(await prepareStartup(page, eventUrl, options), "queue-expired");
        const recovery = new KlookQueueRecovery(page, eventUrl, 500);
        let selections = 0;
        const noRecovery = { isRequired: async () => false, recover: async () => { throw new Error("不應執行"); } };
        await assert.rejects(prepareBooking({
            selectSeats: async () => {
                selections++;
                // 原恢復完成後再出現相同提示，仍應停止，不能建立第二份額度。
                clock.now = sale + 180_000;
                await page.setContent(logged + tickets + queue);
                throw new Error("再次排隊逾期");
            },
            confirmSeats: async () => { throw new Error("不應確認"); },
            prepareContact: async () => { throw new Error("不應提交"); },
        }, recovery, noRecovery), /恢復上限/);
        assert.equal(selections, 1);
        assert.equal(visits.length, 1);
    }, () => ({ body: logged + tickets + '<button>重新整理</button>' + queue.replace('document.body.dataset.clicked=1', "document.querySelector('.klk-modal-alert').remove();document.querySelector('#ticket-options').insertAdjacentHTML('beforeend','<button>重新整理</button>')") }));
});

test("首頁手動登入等待也受開賣固定截止限制", async () => {
    await scenario(async (page, clock, visits) => {
        await page.unroute("**/*");
        await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: '<nav class="default-header"><button class="default-header_signin">登入</button></nav>' }));
        await assert.rejects(prepareStartup(page, eventUrl, options), /登入等待逾時/);
        assert.equal(clock.now, sale + 120_000);
        assert.equal(visits.length, 0);
    }, () => ({ body: logged }));
});

test("人工登入超過六十秒成功仍可待命；bookings 返回不取代定時刷新", async () => {
    for (const redirect of [false, true]) {
        await scenario(async (page, clock, visits) => {
            let restored = false;
            page.waitForTimeout = async ms => {
                if (!restored) {
                    restored = true;
                    clock.now += 70_000;
                    if (redirect) await page.goto("https://www.klook.com/zh-TW/bookings/");
                    else await page.setContent(logged + coming);
                } else clock.now += ms;
            };
            assert.equal(await prepareStartup(page, eventUrl, options), "ready");
            assert.equal(clock.now, sale);
            assert.deepEqual(visits, redirect ? [sale - 75_000, sale - 5000, sale - 1000] : [sale - 75_000, sale - 1000]);
        }, visit => ({ body: visit === 1 ? '<nav class="default-header"><button class="default-header_signin">登入</button></nav>' + coming : logged + tickets }), sale - 75_000);
    }
});
