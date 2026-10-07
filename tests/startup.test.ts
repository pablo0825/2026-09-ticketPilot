import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { prepareStartup, readLoginState, waitForLogin } from "../src/platforms/klook/startup.js";

const homeUrl = "https://www.klook.com/zh-TW/";
const eventUrl = "https://www.klook.com/zh-TW/event-detail/startup-fixture/";
const logged = '<nav class="default-header"><div class="default-header_logged-in"><button class="default-header_avatar">fixture avatar</button></div></nav>';
const loggedOut = '<nav class="default-header"><button class="default-header_signin">登入</button></nav>';
const tickets = '<div id="ticket-options"><div class="spec-LwNjSh">10月3日</div><button onclick="document.body.dataset.next=1">下一步</button></div>';
const options = { pageTimeout: 500, loginTimeout: 100, pollInterval: 10 };

async function routePages(page: Page, home: string, event: string, status = 200, failedPage: "home" | "event" = "home") {
    const navigations: string[] = [];
    await page.route("**/*", route => {
        const url = route.request().url();
        if (route.request().isNavigationRequest()) navigations.push(url);
        return route.fulfill({
            status: (failedPage === "home" ? url === homeUrl : url === eventUrl) ? status : 200,
            contentType: "text/html; charset=utf-8",
            body: url === homeUrl ? home : event,
        });
    });
    return navigations;
}

test("登入 DOM：可見唯一帳戶／登入入口，未知、隱藏、重複及登入歷史不當作已登入", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await routePages(page, logged, logged);
        await page.goto(homeUrl);
        const cases: [string, "logged-in" | "logged-out" | "unknown"][] = [
            [logged, "logged-in"],
            [loggedOut, "logged-out"],
            ["<main>載入中</main>", "unknown"],
            [`<div style="display:none">${logged}</div>`, "unknown"],
            [`${logged}${logged}`, "unknown"],
            [logged.replace('</nav>', '<button class="default-header_signin">登入</button></nav>'), "unknown"],
            [logged.replace('class="default-header_avatar"', 'class="default-header_avatar" style="visibility:hidden"'), "unknown"],
            [logged.replace('</div></nav>', '<button class="default-header_avatar">第二個</button></div></nav>'), "unknown"],
            [`${logged}<div class="klk-login__dialog">登入對話框</div>`, "unknown"],
            [`${loggedOut}<div class="klk-login__dialog">曾用帳戶登入</div>`, "logged-out"],
            ['<div class="klk-login__dialog"><button>繼續使用先前帳戶</button></div>', "unknown"],
            [`${logged}<div style="display:none">${loggedOut}</div>`, "logged-in"],
        ];
        for (const [html, expected] of cases) {
            await page.setContent(html);
            assert.equal(await readLoginState(page), expected, html);
        }
        for (const url of ["https://example.com/", "https://klook.com.example.com/", "http://www.klook.com/", "https://www.klook.com/zh-TW/signin/"]) {
            await page.goto(url);
            await page.setContent(logged);
            assert.equal(await readLoginState(page), "unknown", url);
        }
    } finally { await browser.close(); }
});

test("首頁已登入：只導覽一次活動頁，選項即使停用仍可 READY，不點購票", async () => {
    const browser = await chromium.launch();
    try {
        for (const disabled of [false, true]) {
            const page = await browser.newPage();
            try {
                const html = disabled ? tickets.replace('class="spec-LwNjSh"', 'class="spec-LwNjSh disabled-ImixBj"') : tickets;
                const navigations = await routePages(page, logged, logged + html);
                assert.equal(await prepareStartup(page, eventUrl, options), "ready");
                assert.deepEqual(navigations, [homeUrl, eventUrl]);
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});

test("等待手動登入：期間不導覽活動，登入後只導覽一次，不點登入按鈕", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        const navigations = await routePages(page, loggedOut, logged + tickets);
        const originalWait = page.waitForTimeout.bind(page);
        let waits = 0;
        page.waitForTimeout = async milliseconds => {
            waits++;
            assert.deepEqual(navigations, [homeUrl]);
            if (waits === 2) await page.setContent(logged);
            await originalWait(milliseconds);
        };
        assert.equal(await prepareStartup(page, eventUrl, { ...options, loginTimeout: 500 }), "ready");
        assert.equal(waits, 2);
        assert.deepEqual(navigations, [homeUrl, eventUrl]);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally { await browser.close(); }
});

test("首頁或活動頁 HTTP 錯誤停止，沒有自動重新整理或重試", async () => {
    const browser = await chromium.launch();
    try {
        for (const failedPage of ["home", "event"] as const) {
            for (const status of [403, 500]) {
                const page = await browser.newPage();
                try {
                    const navigations = await routePages(page, logged, logged + tickets, status, failedPage);
                    await assert.rejects(prepareStartup(page, eventUrl, options), new RegExp(`HTTP ${status}`));
                    assert.deepEqual(navigations, failedPage === "home" ? [homeUrl] : [homeUrl, eventUrl]);
                    assert.equal(await page.locator("body").getAttribute("data-next"), null);
                } finally { await page.close(); }
            }
        }
    } finally { await browser.close(); }
});

test("活動頁登出、未知提示、缺少選項或登入身分不明均停止", async () => {
    const browser = await chromium.launch();
    try {
        for (const html of [
            loggedOut + tickets,
            logged + tickets + '<div role="dialog"><button onclick="document.body.dataset.dialog=1">未知提示</button></div>',
            logged + '<div id="ticket-options"></div>',
            tickets,
            logged + tickets + '<div class="seatModal">殘留選位畫面</div>',
        ]) {
            const page = await browser.newPage();
            try {
                const navigations = await routePages(page, logged, html);
                await assert.rejects(prepareStartup(page, eventUrl, options), PurchaseStop);
                assert.deepEqual(navigations, [homeUrl, eventUrl]);
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
                assert.equal(await page.locator("body").getAttribute("data-dialog"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});

test("活動頁導向其他網址：停止且不重新導覽目標活動", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const navigations: string[] = [];
    try {
        await page.route("**/*", route => {
            const url = route.request().url();
            if (route.request().isNavigationRequest()) navigations.push(url);
            // 使用頁面導覽讓每次請求都由 fixture 攔截，避免 HTTP redirect chain 連到實站。
            if (url === eventUrl) return route.fulfill({ contentType: "text/html", body: '<script>location.replace("https://www.klook.com/zh-TW/signin/")</script>' });
            return route.fulfill({ contentType: "text/html", body: logged + tickets });
        });
        await assert.rejects(prepareStartup(page, eventUrl, options), /未到達目標活動頁/);
        assert.deepEqual(navigations, [homeUrl, eventUrl, "https://www.klook.com/zh-TW/signin/"]);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally { await browser.close(); }
});

test("已知排隊過期交回既有恢復，不按 OK 或購票下一步", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        const dialog = '<div class="klk-modal-alert"><p>抱歉，時間到了！ 請返回並重新排隊</p><button onclick="document.body.dataset.dialog=1">OK</button></div>';
        const navigations = await routePages(page, logged, logged + tickets + dialog);
        assert.equal(await prepareStartup(page, eventUrl, options), "queue-expired");
        assert.deepEqual(navigations, [homeUrl, eventUrl]);
        assert.equal(await page.locator("body").getAttribute("data-dialog"), null);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally { await browser.close(); }
});

test("排隊提示先出現、登入 header 稍後載入：等待後交回恢復，不點 OK", async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        const dialog = '<div class="klk-modal-alert"><p>抱歉，時間到了！ 請返回並重新排隊</p><button onclick="document.body.dataset.dialog=1">OK</button></div>';
        const navigations = await routePages(page, logged, tickets + dialog);
        const originalWait = page.waitForTimeout.bind(page);
        let waits = 0;
        page.waitForTimeout = async milliseconds => {
            waits++;
            assert.deepEqual(navigations, [homeUrl, eventUrl]);
            assert.equal(await page.locator("body").getAttribute("data-dialog"), null);
            if (waits === 2) await page.locator("body").evaluate((body, header) => body.insertAdjacentHTML("afterbegin", header), logged);
            await originalWait(milliseconds);
        };
        assert.equal(await prepareStartup(page, eventUrl, options), "queue-expired");
        assert.equal(waits, 2);
        assert.equal(await page.locator("body").getAttribute("data-dialog"), null);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally { await browser.close(); }
});

test("登入等待逾時與瀏覽器關閉：停止且未導覽活動", async () => {
    const browser = await chromium.launch();
    try {
        for (const html of [loggedOut, '<main>尚未載入</main>']) {
            const page = await browser.newPage();
            try {
                const navigations = await routePages(page, html, logged + tickets);
                await assert.rejects(prepareStartup(page, eventUrl, options), PurchaseStop);
                assert.deepEqual(navigations, [homeUrl]);
            } finally { await page.close(); }
        }
        const page = await browser.newPage();
        await page.close();
        await assert.rejects(waitForLogin(page, options), /瀏覽器已關閉/);
        await assert.rejects(prepareStartup(page, eventUrl, options), PurchaseStop);
    } finally { await browser.close(); }
});
