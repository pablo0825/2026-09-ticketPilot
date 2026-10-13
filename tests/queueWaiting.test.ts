import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { chromium, type Page } from "playwright";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { prepareStartup } from "../src/platforms/klook/startup.js";
import { KlookQueueWaiting } from "../src/platforms/klook/queueWaiting.js";
import { findQueueControl } from "../src/platforms/klook/queueControl.js";
import { queueRootSelector } from "../src/platforms/klook/queuePage.js";

const eventUrl = "https://www.klook.com/zh-TW/event-detail/102001116-fixture/";
const queueUrl = "https://www.klook.com/zh-TW/platform/queue/174/";
const homeUrl = "https://www.klook.com/zh-TW/";
const logged =
    '<nav class="default-header"><div class="default-header_logged-in"><button class="default-header_avatar">登入</button></div></nav>';
const tickets =
    '<div id="ticket-options"><div class="spec-LwNjSh">選票</div><button onclick="window.record(\'unexpected\')">下一步</button></div>';
const frame =
    '<iframe class="dynamic-frame" src="https://cdn.klook.com/event/queue-snapshot/102001116/zh_TW/web/fixture.html"></iframe>';
const wrap = (body: string) => `<main class="event_queue_desktop">${frame}${body}</main>`;
const waiting =
    '<h2 class="queue-title">排隊中</h2><span class="qmotion__pct">100%</span><button onclick="window.record(\'leave\')">離開</button>';
const admitted =
    '<h2>輪到你了，請盡快完成購票！</h2><span class="qmotion__pct">100%</span><div>順位保留倒數 <span>04</span> : <span>41</span></div>';
const countdown = '<div>開賣倒數 <span id="clock">00:00:01</span></div>';
const options = { queueEnabled: true, queueTimeout: 4000, pageTimeout: 600, pollInterval: 10 };

async function localQueue(page: Page, body: string) {
    await page.route("**/*", route =>
        route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: route.request().url() === queueUrl ? wrap(body) : "",
        }),
    );
    await page.goto(queueUrl);
}

test("真實同網址 reload：倒數、入隊、100%、延遲繼續預訂、返回活動；兩按鈕各一次", async () => {
    const browser = await chromium.launch();
    try {
        for (const fallback of [false, true]) {
            const page = await browser.newPage();
            const clicks: string[] = [];
            const visits: string[] = [];
            let loads = 0;
            await page.exposeFunction("record", (name: string) => clicks.push(name));
            const join = fallback
                ? '<a id="join" href="#" aria-disabled="true" onclick="joinQueue();return false">排隊購票</a>'
                : '<button id="join" disabled onclick="joinQueue()">排隊購票</button>';
            const next = fallback
                ? '<div tabindex="0" onclick="next()">繼續預訂</div>'
                : '<button onclick="next()">繼續預訂</button>';
            await page.route("**/*", route => {
                const url = route.request().url();
                if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame())
                    visits.push(url);
                let body = "";
                if (url === homeUrl) body = logged;
                if (url === eventUrl)
                    body =
                        loads >= 2
                            ? logged + tickets
                            : `<script>location.replace(${JSON.stringify(queueUrl)})</script>`;
                if (url === queueUrl) {
                    loads++;
                    body =
                        loads === 1
                            ? wrap(countdown + join) +
                              `<script>function joinQueue(){window.record('join');document.querySelector('main').innerHTML=${JSON.stringify(frame + waiting)};setTimeout(()=>location.reload(),60)}</script>`
                            : `<script>setTimeout(()=>{document.body.innerHTML=${JSON.stringify(wrap(admitted + next))}},60);function next(){window.record('continue');location.href=${JSON.stringify(eventUrl)}}</script>`;
                }
                return route.fulfill({ contentType: "text/html; charset=utf-8", body });
            });
            const run = prepareStartup(page, eventUrl, options);
            await Promise.race([page.locator("#join").waitFor(), run]);
            assert.deepEqual(clicks, []);
            await page.evaluate(() => {
                document.querySelector("#clock")!.textContent = "00:00:00";
                document.querySelector("#join")!.removeAttribute("disabled");
                document.querySelector("#join")!.removeAttribute("aria-disabled");
            });
            assert.equal(await run, "ready");
            assert.deepEqual(clicks, ["join", "continue"]);
            assert.deepEqual(visits, [homeUrl, eventUrl, queueUrl, queueUrl, eventUrl]);
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("按鈕備援：停用 role 不繞過，重複不任選，說明文字與停用父層不點", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        for (const [body, expected] of [
            ["<button disabled>排隊購票</button>", false],
            ["<button disabled><span>排隊購票</span></button>", false],
            ["<div>排隊購票</div>", false],
            ['<div tabindex="-1">排隊購票</div>', false],
            ['<section tabindex="0"><p>購票操作說明</p><p>排隊購票</p></section>', false],
            ['<div aria-disabled="true"><a href="#">排隊購票</a></div>', false],
            ['<a href="#"><span>排隊購票</span></a>', true],
            ['<button style="display:none">排隊購票</button><button>排隊購票</button>', true],
        ] as const) {
            await page.setContent(wrap(body));
            assert.equal(Boolean(await findQueueControl(page, "排隊購票")), expected, body);
        }
        for (const body of [
            "<button>排隊購票</button><button>排隊購票</button>",
            '<a href="#">排隊購票</a><p>排隊購票</p>',
        ]) {
            await page.setContent(wrap(body));
            await assert.rejects(findQueueControl(page, "排隊購票"), /不唯一/);
        }
    } finally {
        await browser.close();
    }
});

test("錯活動、入口與進度並存、保留過期、提示：不點任何控制項", async () => {
    const browser = await chromium.launch();
    try {
        for (const body of [
            (frame + countdown + "<button>排隊購票</button>").replace("/102001116/", "/999/"),
            frame + countdown + '<button>排隊購票</button><span class="qmotion__pct">1%</span>',
            frame + admitted.replace("04</span> : <span>41", "00</span> : <span>00") + "<button>繼續預訂</button>",
            frame + waiting + '<div role="dialog">錯誤<button>確定</button></div>',
        ]) {
            const page = await browser.newPage();
            let clicks = 0;
            await page.exposeFunction("record", () => clicks++);
            await localQueue(
                page,
                body.replace(/<iframe.*?<\/iframe>/, "") +
                    '<script>document.addEventListener("click",()=>window.record())</script>',
            );
            if (body.includes("/999/"))
                await page
                    .locator("iframe")
                    .evaluate(el =>
                        el.setAttribute("src", "https://cdn.klook.com/event/queue-snapshot/999/zh_TW/web/fixture.html"),
                    );
            await assert.rejects(new KlookQueueWaiting(page, eventUrl, options).handleIfPresent());
            assert.equal(clicks, 0);
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("100% 無繼續預訂不算放行；未知倒數、錯頁及關閉停止", async () => {
    const browser = await chromium.launch();
    try {
        for (const body of [waiting, admitted.replace("04</span> : <span>41", "??") + "<button>繼續預訂</button>"]) {
            const page = await browser.newPage();
            await localQueue(page, body);
            await assert.rejects(
                new KlookQueueWaiting(page, eventUrl, {
                    ...options,
                    queueTimeout: 180,
                    pageTimeout: 80,
                }).handleIfPresent(),
                /上限|未知/,
            );
            await page.close();
        }
        for (const close of [false, true]) {
            const page = await browser.newPage();
            await localQueue(page, waiting);
            const run = new KlookQueueWaiting(page, eventUrl, options).handleIfPresent();
            const rejected = assert.rejects(run);
            if (close) await page.close();
            else await page.goto("https://example.com/");
            await rejected;
        }
    } finally {
        await browser.close();
    }
});

test("點擊結果不明不重按；網站 reload 返回入口也不重新入隊", async () => {
    const browser = await chromium.launch();
    try {
        for (const name of ["排隊購票", "繼續預訂"]) {
            const page = await browser.newPage();
            let clicks = 0;
            await page.exposeFunction("record", () => clicks++);
            const content = name === "排隊購票" ? countdown.replace("00:00:01", "00:00:00") : admitted;
            await localQueue(page, content + `<button onclick="window.record();location.reload()">${name}</button>`);
            await assert.rejects(
                new KlookQueueWaiting(page, eventUrl, { ...options, pageTimeout: 180 }).handleIfPresent(),
                /未確認|未知/,
            );
            assert.equal(clicks, 1);
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("未啟用遇排隊停止；已啟用但無排隊直接 READY", async () => {
    const browser = await chromium.launch();
    try {
        for (const queue of [false, true]) {
            const page = await browser.newPage();
            await page.route("**/*", route =>
                route.fulfill({
                    contentType: "text/html; charset=utf-8",
                    body:
                        route.request().url() === homeUrl
                            ? logged
                            : queue
                              ? `<script>location.replace(${JSON.stringify(queueUrl)})</script>`
                              : logged + tickets,
                }),
            );
            if (queue) await assert.rejects(prepareStartup(page, eventUrl, { ...options, queueEnabled: false }));
            else assert.equal(await prepareStartup(page, eventUrl, options), "ready");
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("排程刷新遇排隊跨過兩分鐘仍可接續；放行後不額外刷新且保留最早開賣時間", async () => {
    const browser = await chromium.launch();
    try {
        for (const early of [false, true]) {
            const page = await browser.newPage();
            const sale = Date.parse("2026-10-13T14:00:00+08:00");
            let now = sale - 1000;
            let visits = 0;
            let inQueue = false;
            const timer = mock.method(Date, "now", () => now);
            const sleep = page.waitForTimeout.bind(page);
            page.waitForTimeout = async ms => {
                now += inQueue && !early ? 121_000 : ms;
                await sleep(1);
            };
            try {
                await page.route("**/*", route => {
                    const url = route.request().url();
                    let body = logged;
                    if (url === eventUrl) {
                        visits++;
                        body =
                            visits === 1
                                ? logged +
                                  '<div id="ticket-options"><div class="package-wrapper stateText">即將開賣</div></div>'
                                : visits === 2
                                  ? `<script>location.replace(${JSON.stringify(queueUrl)})</script>`
                                  : logged + tickets;
                    }
                    if (url === queueUrl) {
                        inQueue = true;
                        body = wrap(
                            admitted +
                                `<button onclick="location.href=${JSON.stringify(eventUrl).replaceAll('"', "&quot;")}">繼續預訂</button>`,
                        );
                    }
                    if (url.includes("cdn.klook.com")) body = "";
                    return route.fulfill({ contentType: "text/html; charset=utf-8", body });
                });
                assert.equal(
                    await prepareStartup(page, eventUrl, {
                        ...options,
                        queueTimeout: 600_000,
                        pageTimeout: 180_000,
                        saleSchedule: { saleAt: "2026-10-13T14:00:00+08:00" },
                    }),
                    "ready",
                );
                assert.equal(visits, 3);
                assert(now >= (early ? sale : sale + 120_000));
            } finally {
                timer.mock.restore();
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});

test("放行後登入、提示、選票資料仍須完整；未知錯誤不判售罄", async () => {
    const browser = await chromium.launch();
    try {
        for (const returned of [
            '<nav class="default-header"><button class="default-header_signin">登入</button></nav>' + tickets,
            logged + tickets + '<div role="dialog">未知提示</div>',
            logged,
            logged + tickets + '<div class="seatModal">舊選位</div>',
            logged +
                tickets.replace("</div><button", '</div><div class="package-wrapper stateText">即將開賣</div><button'),
            logged + tickets.replace("</div><button", '</div><div class="package-wrapper stateText">未知</div><button'),
            logged +
                '<div id="ticket-options"><div class="package-wrapper stateText">即將開賣</div><div class="package-wrapper stateText">即將開賣</div></div>',
        ]) {
            const page = await browser.newPage();
            let visits = 0;
            await page.route("**/*", route => {
                const url = route.request().url();
                let body = "";
                if (url === homeUrl) body = logged;
                if (url === eventUrl)
                    body = ++visits === 1 ? `<script>location.replace(${JSON.stringify(queueUrl)})</script>` : returned;
                if (url === queueUrl)
                    body = wrap(admitted + `<button onclick="location.href='${eventUrl}'">繼續預訂</button>`);
                return route.fulfill({ contentType: "text/html; charset=utf-8", body });
            });
            await assert.rejects(
                prepareStartup(page, eventUrl, { ...options, pageTimeout: 200 }),
                /失效|提示|逾時|選位|矛盾/,
            );
            assert.equal(visits, 2);
            await page.close();
        }
    } finally {
        await browser.close();
    }
});

test("網站連續 reload 不重設總期限", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await localQueue(page, waiting);
        let now = Date.now();
        let reloads = 0;
        const clock = mock.method(Date, "now", () => now);
        page.waitForTimeout = async ms => {
            now += ms;
            reloads++;
            await page.reload();
        };
        try {
            await assert.rejects(
                new KlookQueueWaiting(page, eventUrl, {
                    ...options,
                    queueTimeout: 100,
                    pollInterval: 25,
                }).handleIfPresent(),
                /等待上限/,
            );
            assert.equal(reloads, 4);
        } finally {
            clock.mock.restore();
        }
        await page.close();
    } finally {
        await browser.close();
    }
});

test("繼續預訂被遮擋點擊逾時，沒有備援重按或任何其他點擊", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        let clicks = 0;
        await page.exposeFunction("record", () => clicks++);
        await localQueue(
            page,
            admitted +
                '<button onclick="window.record()">繼續預訂</button><div style="position:fixed;inset:0;z-index:100">遮擋</div>',
        );
        await assert.rejects(
            new KlookQueueWaiting(page, eventUrl, { ...options, pageTimeout: 150 }).handleIfPresent(),
            /點擊結果不明/,
        );
        assert.equal(clicks, 0);
    } finally {
        await browser.close();
    }
});

test("倒數非零即使按鈕啟用也不按，歸零後只按一次", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        let clicks = 0;
        let polls = 0;
        await page.exposeFunction("record", () => clicks++);
        await localQueue(
            page,
            countdown + `<button onclick="window.record();location.href='${eventUrl}'">排隊購票</button>`,
        );
        const sleep = page.waitForTimeout.bind(page);
        page.waitForTimeout = async ms => {
            polls++;
            assert.equal(clicks, 0);
            await page.locator("#clock").evaluate(el => (el.textContent = "00:00:00"));
            page.waitForTimeout = sleep;
            await sleep(ms);
        };
        // 成功點擊後的等待只觀察結果，不再改動倒數。
        const navigate = page.waitForURL(eventUrl);
        const run = new KlookQueueWaiting(page, eventUrl, options).handleIfPresent();
        await Promise.race([navigate, run]);
        page.waitForTimeout = sleep;
        assert.equal(await run, true);
        assert(polls >= 1);
        assert.equal(clicks, 1);
    } finally {
        await browser.close();
    }
});

test("快照讀取中網站 reload：忽略舊文件或導頁讀取錯誤，辨識新文件後單次繼續", async () => {
    const browser = await chromium.launch();
    try {
        for (const destroyed of [false, true]) {
            const page = await browser.newPage();
            let loads = 0;
            let clicks = 0;
            await page.exposeFunction("record", () => clicks++);
            await page.route("**/*", route => {
                let body = "";
                if (route.request().url() === queueUrl) {
                    body = wrap(
                        ++loads === 1
                            ? waiting
                            : admitted +
                                  `<button onclick="window.record();location.href='${eventUrl}'">繼續預訂</button>`,
                    );
                }
                return route.fulfill({ contentType: "text/html; charset=utf-8", body });
            });
            await page.goto(queueUrl);
            const evaluate = page.evaluate.bind(page);
            let interrupted = false;
            const interception = mock.method(page, "evaluate", async (fn: any, arg: any) => {
                const result = await evaluate(fn, arg);
                if (arg === queueRootSelector && !interrupted) {
                    interrupted = true;
                    await page.reload();
                    if (destroyed)
                        throw new Error("Execution context was destroyed, most likely because of a navigation");
                }
                return result;
            });
            try {
                assert.equal(await new KlookQueueWaiting(page, eventUrl, options).handleIfPresent(), true);
                assert.equal(interrupted, true);
                assert.equal(loads, 2);
                assert.equal(clicks, 1);
            } finally {
                interception.mock.restore();
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});

test("動作前重讀遇刷新、階段或倒數變動：本輪不點，下一輪仍可單次入隊", async () => {
    const browser = await chromium.launch();
    try {
        for (const change of ["reload", "countdown", "stage", "navigation-error", "stop"] as const) {
            const page = await browser.newPage();
            let clicks = 0;
            let reads = 0;
            let polls = 0;
            await page.exposeFunction("record", () => clicks++);
            const entry =
                countdown.replace("00:00:01", "00:00:00") +
                `<button onclick="window.record();location.href='${eventUrl}'">排隊購票</button>`;
            await localQueue(page, entry);
            const evaluate = page.evaluate.bind(page);
            const sleep = page.waitForTimeout.bind(page);

            // 在動作前的第二次快照讀取插入變動，不攔截控制項判斷。
            const interception = mock.method(page, "evaluate", async (fn: any, arg: any) => {
                if (arg !== queueRootSelector || ++reads !== 2) return evaluate(fn, arg);
                if (change === "countdown") {
                    await page.locator("#clock").evaluate(el => (el.textContent = "00:00:01"));
                } else if (change === "stage") {
                    await page.locator("main").evaluate((el, html) => (el.innerHTML = html), frame + waiting);
                } else {
                    const previous = await evaluate(fn, arg);
                    await page.reload();
                    if (change === "navigation-error") throw new Error("Execution context was destroyed");
                    if (change === "stop") throw new PurchaseStop("測試安全停止");
                    return previous;
                }
                return evaluate(fn, arg);
            });
            page.waitForTimeout = async ms => {
                polls++;
                assert.equal(clicks, 0, "變動當輪不可點擊");
                await page.locator("main").evaluate((el, html) => (el.innerHTML = html), frame + entry);
                page.waitForTimeout = sleep;
                await sleep(ms);
            };

            // 除明確停止外，下一輪恢復合法入口後應只點一次。
            try {
                const run = new KlookQueueWaiting(page, eventUrl, options).handleIfPresent();
                if (change === "stop") {
                    await assert.rejects(run, /測試安全停止/);
                    assert.equal(clicks, 0);
                    assert.equal(polls, 0);
                } else {
                    assert.equal(await run, true);
                    assert.equal(polls, 1);
                    assert.equal(clicks, 1);
                }
                assert(reads >= 2);
            } finally {
                interception.mock.restore();
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});

test("按鈕缺失或停用：提早返回仍輪詢並因未知狀態逾時，零次點擊", async () => {
    const browser = await chromium.launch();
    try {
        for (const button of ["", '<button disabled onclick="window.record()">排隊購票</button>']) {
            const page = await browser.newPage();
            let clicks = 0;
            let polls = 0;
            let now = Date.now();
            await page.exposeFunction("record", () => clicks++);
            // 保留入口文字，確保快照辨識為 countdown，再由控制項搜尋提早返回。
            const label = button || "<p>排隊購票</p>";
            await localQueue(page, countdown.replace("00:00:01", "00:00:00") + label);
            const clock = mock.method(Date, "now", () => now);
            page.waitForTimeout = async ms => {
                assert(ms > 0);
                polls++;
                now += ms;
            };
            try {
                await assert.rejects(
                    new KlookQueueWaiting(page, eventUrl, {
                        ...options,
                        pageTimeout: 100,
                        pollInterval: 25,
                    }).handleIfPresent(),
                    /排隊頁持續未知/,
                );
                assert.equal(polls, 4);
                assert.equal(clicks, 0);
            } finally {
                clock.mock.restore();
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});
