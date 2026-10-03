import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import type { PurchaseTarget } from "../src/core/types.js";
import { KlookTargetAttempt } from "../src/platforms/klook/targetAttempt.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";

const active = "active-vB3nra";
const unavailable = "disabled-ImixBj soldout-sBHQQa";
const url = fixtureConfig.eventUrl;
const first = fixtureConfig.targets[0]!;
type FixtureOptions = {
    dates?: string[];
    times?: string[];
    area?: string;
    disableAfterAreaClick?: "日期" | "時間";
};

// 日期及時間的兩個停用 class 組合以本機 fixture 模擬，不代表實站庫存驗證。
function fixture(options: FixtureOptions = {}): string {
    const group = (name: string, labels: string[], states: string[]) =>
        `<div class="skuGroup-hk2pfU" data-group="${name}"><div class="name-Cu4gxk">${name}</div><div>${labels.map((label, index) =>
            `<div class="spec-LwNjSh ${states[index] ?? ""}" data-option="${name}:${index}">${label}</div>`).join("")}</div></div>`;
    const panel = '<div class="main_right-ZMnX67"><div class="pc_header_center-mSlDdM"><span>SESSION</span></div><div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">A區 NT$4880</div><div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>A1</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>15</ins></span></div></div><div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">NT$4880</div></div><button onclick="document.body.dataset.confirmed=1">確認</button></div>';
    return `<div id="ticket-options">${group("日期", ["10月3日(週六)", "10月4日(週日)"], options.dates ?? [active, ""])}${group("時間", ["12:00", "18:00"], options.times ?? [active, ""])}${group("票種", ["A區 NT$4880"], [options.area ?? ""])}<div class="eventUnit-kxDycC"><div class="value-xWKzpL">1</div>最多4張</div><button>重新整理</button><button id="next">下一步</button></div>
        <script>
        for (const option of document.querySelectorAll('.spec-LwNjSh')) option.onclick = () => {
            document.body.dataset.clicks = (document.body.dataset.clicks || '') + option.dataset.option + ';';
            for (const sibling of option.parentElement.children) sibling.classList.remove('${active}');
            option.classList.add('${active}');
            const groupToDisable = ${JSON.stringify(options.disableAfterAreaClick ?? null)};
            if (groupToDisable && option.dataset.option === '票種:0') {
                document.querySelector('[data-group="' + groupToDisable + '"] .${active}').classList.add('disabled-ImixBj', 'soldout-sBHQQa');
            }
        };
        document.querySelector('#next').onclick = () => {
            document.body.dataset.next = String(Number(document.body.dataset.next || 0) + 1);
            const day = document.querySelector('[data-group="日期"] .${active}').textContent.includes('4日') ? '4日 週日' : '3日 週六';
            const hour = document.querySelector('[data-group="時間"] .${active}').textContent === '18:00' ? '6:00' : '12:00';
            const session = '2026年10月' + day + ' 下午' + hour;
            document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(panel)}.replace('SESSION', session));
        };
        </script>`;
}

async function load(page: Page, html: string): Promise<void> {
    await page.route("**/*", route => route.fulfill({ body: html, contentType: "text/html; charset=utf-8" }));
    await page.goto(url);
}

function selection(page: Page, targets: PurchaseTarget[]) {
    const attempts: string[] = [];
    let recoveries = 0;
    let returns = 0;
    const adapter = new KlookTargetAttempt(page, url, 300);
    const strategy = new PriorityStrategy({ ...fixtureConfig, targets });
    const recovery = {
        async isRequired() { return false; },
        async recover() { recoveries++; },
    };
    const run = () => prepareBooking({
        selectSeats: () => strategy.select({
            async attempt(target) {
                attempts.push(`${target.date} ${target.time}`);
                return adapter.attempt(target);
            },
            async returnAfterFailure() { returns++; assert.fail("停用不得呼叫返回"); },
        }),
        async confirmSeats() {},
        async prepareContact() {},
    }, recovery, recovery);
    return { run, attempts, counts: () => ({ recoveries, returns }) };
}

test("日期或時間明確停用：實際 adapter 前進下一場次，零返回與恢復", async () => {
    const browser = await chromium.launch();
    try {
        for (const mode of ["date", "time"]) {
            const page = await browser.newPage();
            try {
                await load(page, fixture(mode === "date" ? { dates: [unavailable, ""] } : { times: [unavailable, ""] }));
                const next = mode === "date" ? { ...first, date: "2026-10-04" } : { ...first, time: "18:00" };
                const flow = selection(page, [first, next]);
                const result = await flow.run();
                assert.equal(result.target.date, next.date);
                assert.equal(result.target.time, next.time);
                assert.equal(flow.attempts.length, 2);
                assert.deepEqual(flow.counts(), { recoveries: 0, returns: 0 });
                assert.equal(await page.locator("body").getAttribute("data-clicks"), mode === "date" ? "日期:1;票種:0;" : "時間:1;票種:0;");
                assert.equal(await page.locator("body").getAttribute("data-next"), "1");
                assert.equal(await page.locator("body").getAttribute("data-confirmed"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});

test("所有日期或時間皆明確停用：停止且不循環順位", async () => {
    const browser = await chromium.launch();
    try {
        for (const mode of ["date", "time"]) {
            const page = await browser.newPage();
            try {
                await load(page, fixture(mode === "date" ? { dates: [unavailable, unavailable] } : { times: [unavailable, unavailable] }));
                const next = mode === "date" ? { ...first, date: "2026-10-04" } : { ...first, time: "18:00" };
                const flow = selection(page, [first, next]);
                await assert.rejects(flow.run(), /NO_TARGET_AVAILABLE/);
                await assert.rejects(flow.run(), /NO_TARGET_AVAILABLE/);
                assert.equal(flow.attempts.length, 2);
                assert.deepEqual(flow.counts(), { recoveries: 0, returns: 0 });
                assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});

test("日期／時間停用缺少證據、狀態矛盾、重複或缺失：停止而非跳順位", async () => {
    const browser = await chromium.launch();
    try {
        for (const group of ["日期", "時間"]) {
            for (const mode of ["unknown", "active-disabled", "duplicate", "missing"]) {
                const page = await browser.newPage();
                try {
                    await load(page, fixture());
                    await page.locator(`[data-option="${group}:0"]`).evaluate((element, mode) => {
                        if (mode === "missing") { element.remove(); return; }
                        if (mode === "duplicate") { element.after(element.cloneNode(true)); return; }
                        element.classList.add("disabled-ImixBj");
                        if (mode === "active-disabled") element.classList.add("soldout-sBHQQa");
                        else element.classList.remove("active-vB3nra");
                    }, mode);
                    const flow = selection(page, [first, { ...first, date: "2026-10-04", time: "18:00" }]);
                    await assert.rejects(flow.run(), PurchaseStop);
                    assert.equal(flow.attempts.length, 1, `${group}/${mode}`);
                    assert.deepEqual(flow.counts(), { recoveries: 0, returns: 0 });
                    assert.equal(await page.locator("body").getAttribute("data-next"), null);
                } finally { await page.close(); }
            }
        }
    } finally { await browser.close(); }
});

test("選票操作後日期或時間才停用：停止送出，不改試其他場次", async () => {
    const browser = await chromium.launch();
    try {
        for (const group of ["日期", "時間"] as const) {
            const page = await browser.newPage();
            try {
                await load(page, fixture({ disableAfterAreaClick: group }));
                const flow = selection(page, [first, { ...first, date: "2026-10-04", time: "18:00" }]);
                await assert.rejects(flow.run(), PurchaseStop);
                assert.equal(flow.attempts.length, 1);
                assert.deepEqual(flow.counts(), { recoveries: 0, returns: 0 });
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});

test("切換已選日期或時間後，下游仍殘留停用選項：停止，不當成新場次無票", async () => {
    const browser = await chromium.launch();
    try {
        for (const mode of ["date", "time", "date-unselected", "time-unselected"]) {
            const page = await browser.newPage();
            try {
                await load(page, fixture(mode.startsWith("date") ? { dates: mode.endsWith("unselected") ? ["", ""] : undefined, times: [unavailable, ""] } : { times: mode.endsWith("unselected") ? ["", ""] : undefined, area: "disabled-ImixBj" }));
                const target = mode.startsWith("date") ? { ...first, date: "2026-10-04" } : { ...first, time: "18:00" };
                const flow = selection(page, [target, first]);
                await assert.rejects(flow.run(), PurchaseStop);
                assert.equal(flow.attempts.length, 1);
                assert.deepEqual(flow.counts(), { recoveries: 0, returns: 0 });
                assert.equal(await page.locator("body").getAttribute("data-next"), null);
            } finally { await page.close(); }
        }
    } finally { await browser.close(); }
});
