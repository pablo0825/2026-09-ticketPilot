import { PurchaseStop } from "../src/core/purchaseStop.js";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { KlookTicketSelector } from "../src/platforms/klook/ticketSelector.js";

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });
const target = { date: "2026-10-03", time: "12:00", area: "A區", quantity: 1, adjacent: false };

// 僅本機測試：結構依讀取到的選票 DOM 縮減，不連線 Klook、不使用登入資料。
function fixture(initialQuantity = 0, brokenSelection = false) {
    const group = (name: string, choices: string[], selected: number) =>
        `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div>${choices.map((text, i) =>
            `<div class="spec-LwNjSh ${i === selected ? "active-vB3nra" : ""}">${text}</div>`).join("")}</div></div>`;
    return `<div id="ticket-info"><p>活動日期｜2026 年 10 月 03 日（六）</p></div><div id="ticket-options">
        ${group("日期", ["10月3日(週六)"], 0)}
        ${group("時間", ["12:00", "18:00"], 1)}
        ${group("票種", ["A區（NT$4,880）", "A區愛心席（NT$2,440）", "B區（NT$3,880）"], 2)}
        <div class="eventUnit-kxDycC"><div class="counter-vVrWZ9">
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_minus_xs">−</i></div>
          <div class="value-xWKzpL">${initialQuantity}</div>
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_plus_xs">＋</i></div>
        </div><div>最多4張</div></div>
        <div class="consecutive"><span role="checkbox" tabindex="0" aria-checked="true">相連座位<input type="checkbox" checked hidden></span></div>
        <button onclick="document.body.dataset.next='clicked'">下一步</button>
        </div><script>(() => {
        document.querySelectorAll('.spec-LwNjSh').forEach(el => el.onclick = () => {
          if (${brokenSelection}) return;
          [...el.parentElement.children].forEach(item => item.classList.remove('active-vB3nra'));
          el.classList.add('active-vB3nra');
        });
        const value = document.querySelector('.value-xWKzpL');
        document.querySelectorAll('.btn-vDH5IS').forEach((el, index) => el.onclick = () => {
          value.textContent = String(Math.max(0, Math.min(4, Number(value.textContent) + (index ? 1 : -1))));
        });
        const checkbox = document.querySelector('[role=checkbox]');
        checkbox.onclick = () => {
          const input = checkbox.querySelector('input');
          input.checked = !input.checked;
          if (input.checked) checkbox.setAttribute('aria-checked', 'true');
          else checkbox.removeAttribute('aria-checked');
          checkbox.dataset.clicks = String(Number(checkbox.dataset.clicks || 0) + 1);
        };
        })();</script>`;
}

test("選 A 區一張、保留不適用的連票設定並停在下一步之前；重跑不累加", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 800);
        await adapter.selectAndVerify(target, 4880);
        // 重跑應保持指定張數，不可再次累加票數。
        await adapter.selectAndVerify(target, 4880);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "1");
        assert.equal(await page.locator('[role=checkbox]').getAttribute('aria-checked'), "true");
        assert.deepEqual(await page.locator('.active-vB3nra').allTextContents(), ["10月3日(週六)", "12:00", "A區（NT$4,880）"]);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("從三張減到一張", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture(3));
        await new KlookTicketSelector(page, 800).selectAndVerify(target, 4880);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "1");
    } finally { await page.close(); }
});

test("單張票沒有連票元件也可通過；多張仍驗證連票設定", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('.consecutive').evaluate(el => el.remove());
        await new KlookTicketSelector(page, 800).selectAndVerify(target, 4880);
        await page.setContent(fixture());
        await new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 2 }, 4880);
        assert.equal(await page.locator('[role=checkbox]').getAttribute('aria-checked'), null);
        assert.equal(await page.locator('.consecutive input').isChecked(), false);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("超過 UI 上限停止，不點下一步", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await assert.rejects(new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 5 }, 4880), /超過 UI 上限/);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "0");
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("點擊未生效時不宣告成功", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture(0, true));
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target, 4880), /點選後沒有確認選中/);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("錯誤設定或年份不符時停止，不變更選票", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 400);
        for (const invalid of [
            { ...target, date: "2026-02-30" },
            { ...target, time: "25:00" },
            { ...target, quantity: 0 },
            { ...target, area: "　" },
            { ...target, date: "2027-10-03" },
        ]) {
            await assert.rejects(adapter.selectAndVerify(invalid, 4880));
        }
        assert.deepEqual(await page.locator('.active-vB3nra').allTextContents(), ["10月3日(週六)", "18:00", "B區（NT$3,880）"]);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("同名票區重複時停止，不任選第一個", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.getByText('A區（NT$4,880）', { exact: true }).evaluate(el => {
            el.parentElement!.append(el.cloneNode(true));
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target, 4880), /多個匹配項/);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "0");
    } finally { await page.close(); }
});

test("加號停用時停止，不誤判目標票數已完成", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('.klk-icon-icon_other_plus_xs').evaluate(el => {
            el.parentElement!.classList.add('btnDisabled-O7fKf4');
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target, 4880), /數量按鈕目前停用/);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "0");
    } finally { await page.close(); }
});

test("調整數量意外重設票區時，最終驗證必須失敗", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('.klk-icon-icon_other_plus_xs').evaluate(el => {
            el.parentElement!.addEventListener('click', () => {
                for (const option of document.querySelectorAll('.spec-LwNjSh')) {
                    if (option.textContent === 'A區（NT$4,880）') option.classList.remove('active-vB3nra');
                    if (option.textContent === 'B區（NT$3,880）') option.classList.add('active-vB3nra');
                }
            });
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target, 4880), /票區最終驗證不一致/);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("多張票的连票勾選未生效時仍然失敗", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('[role=checkbox]').evaluate(el => { (el as HTMLElement).onclick = () => {}; });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify({ ...target, quantity: 2 }, 4880));
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("名稱與單價唯一匹配，三種價格格式皆可設定兩張", async () => {
    const page = await browser.newPage();
    try {
        for (const label of ["A區（NT$4,880）", "A區 NT$4880", "A區 $4,880"]) {
            await page.setContent(fixture().replaceAll("A區（NT$4,880）", label));
            await new KlookTicketSelector(page, 500).selectAndVerify({ ...target, quantity: 2 }, 4880);
            assert.equal(await page.locator('.value-xWKzpL').innerText(), "2");
            assert.equal(await page.locator('.spec-LwNjSh.active-vB3nra').filter({ hasText: label }).count(), 1);
            assert.equal(await page.locator('body').getAttribute('data-next'), null);
        }
    } finally { await page.close(); }
});

test("價格不符、同價異名、格式未知與重複選項均停止，不點票種或下一步", async () => {
    const page = await browser.newPage();
    try {
        for (const label of ["A區 NT$5000", "A區身障票 NT$4880", "A區 NT$48,80", "A區 NT$4880起", "A區（NT$4,880）</div><div class='spec-LwNjSh'>A區 $4,880"]) {
            await page.setContent(fixture().replace("A區（NT$4,880）", label));
            await page.locator('.skuGroup-hk2pfU').filter({ hasText: "票種" }).evaluate(el => {
                el.addEventListener('click', () => document.body.dataset.ticketClicked = '1');
            });
            await assert.rejects(new KlookTicketSelector(page, 500).selectAndVerify(target, 4880), PurchaseStop);
            assert.equal(await page.locator('body').getAttribute('data-ticket-clicked'), null);
            assert.equal(await page.locator('body').getAttribute('data-next'), null);
        }
    } finally { await page.close(); }
});

test("調整張數後價格改變仍須停止，不沿用先前核對", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('.klk-icon-icon_other_plus_xs').evaluate(el => {
            el.parentElement!.addEventListener('click', () => {
                const option = [...document.querySelectorAll('.spec-LwNjSh')].find(item => item.textContent === 'A區（NT$4,880）')!;
                option.textContent = 'A區 NT$5000';
            });
        });
        await assert.rejects(new KlookTicketSelector(page, 500).selectAndVerify(target, 4880), PurchaseStop);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("價格不符即使同時有恢復需求，也不換順位、不返回、不消耗恢復", async () => {
    const page = await browser.newPage();
    const attempts: string[] = [];
    let returns = 0; let recoveries = 0; let active = false;
    const recovery = { async isRequired() { return active; }, async recover() { recoveries++; } };
    const strategy = new PriorityStrategy({ ...eventConfig, targets: [
        { ...eventConfig.targets[0]!, area: 'A區' }, { ...eventConfig.targets[0]!, area: 'B區' },
    ] });
    try {
        await page.setContent(fixture().replace('A區（NT$4,880）', 'A區 NT$5000'));
        await assert.rejects(prepareBooking({
            selectSeats: () => strategy.select({
                async attempt(candidate) {
                    attempts.push(candidate.area);
                    active = true;
                    await new KlookTicketSelector(page, 500).selectAndVerify(candidate, candidate.expectation.unitPrice);
                    return { status: 'matched', value: true };
                },
                async returnAfterFailure() { returns++; },
            }),
            async confirmSeats() { assert.fail('不得進入選位確認'); },
            async prepareContact() { assert.fail('不得填表'); },
        }, recovery, recovery), PurchaseStop);
        assert.deepEqual(attempts, ['A區']);
        assert.equal(returns, 0);
        assert.equal(recoveries, 0);
    } finally { await page.close(); }
});

test("日期改用斜線仍可選票；只有其他區塊或開賣日符合時不點選", async () => {
    const page = await browser.newPage();
    const original = '<div id="ticket-info"><p>活動日期｜2026 年 10 月 03 日（六）</p></div>';
    try {
        await page.setContent(fixture().replace(original, '<div id="ticket-info"><p>• 時間｜2026/10/03（六）</p></div>'));
        await new KlookTicketSelector(page, 500).selectAndVerify(target, 4880);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), '1');
        for (const dateInfo of [
            '<div id="ticket-info"><p>活動日期｜2026/10/04</p></div><p>2026年10月3日</p>',
            '<div id="ticket-info"><p>開賣日期｜2026/10/03</p></div>',
        ]) {
            await page.setContent(fixture().replace(original, dateInfo));
            await page.locator('#ticket-options').evaluate(el => el.addEventListener('click', () => document.body.dataset.clicked = '1'));
            await assert.rejects(new KlookTicketSelector(page, 250).selectAndVerify(target, 4880), PurchaseStop);
            assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
            assert.equal(await page.locator('body').getAttribute('data-next'), null);
        }
    } finally { await page.close(); }
});

test("兩張票可重新勾選連位；已符合設定不重複點擊", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 800);
        const twoTickets = { ...target, quantity: 2 };
        await adapter.selectAndVerify(twoTickets, 4880);
        await adapter.selectAndVerify(twoTickets, 4880);
        assert.equal(await page.locator('[role=checkbox]').getAttribute('data-clicks'), '1');
        await adapter.selectAndVerify({ ...twoTickets, adjacent: true }, 4880);
        await adapter.selectAndVerify({ ...twoTickets, adjacent: true }, 4880);
        assert.equal(await page.locator('.consecutive input').isChecked(), true);
        assert.equal(await page.locator('[role=checkbox]').getAttribute('data-clicks'), '2');
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("連位元件缺少、重複、類型錯誤或狀態矛盾時，不操作連位或提交", async () => {
    const page = await browser.newPage();
    try {
        for (const mode of ['missing', 'duplicate', 'wrong-type', 'indeterminate', 'mixed', 'contradiction', 'unknown', 'outer-duplicate', 'outer-hidden']) {
            await page.setContent(fixture());
            await page.locator('[role=checkbox]').evaluate((element, mode) => {
                const input = element.querySelector('input')!;
                if (mode === 'missing') input.remove();
                if (mode === 'duplicate') element.append(input.cloneNode());
                if (mode === 'wrong-type') input.type = 'text';
                if (mode === 'indeterminate') input.indeterminate = true;
                if (mode === 'mixed') element.setAttribute('aria-checked', 'mixed');
                if (mode === 'contradiction') input.checked = false;
                if (mode === 'unknown') element.removeAttribute('aria-checked');
                if (mode === 'outer-duplicate') element.parentElement!.append(element.cloneNode(true));
                if (mode === 'outer-hidden') (element as HTMLElement).style.display = 'none';
            }, mode);
            await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify({ ...target, quantity: 2 }, 4880), /相連座位/);
            assert.equal(await page.locator('[data-clicks]').count(), 0, mode);
            assert.equal(await page.locator('body').getAttribute('data-next'), null, mode);
        }
    } finally { await page.close(); }
});

test("連位在最後驗證時被重設，必須停止", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('[role=checkbox]').evaluate(element => {
            const original = element.getAttribute.bind(element);
            let reads = 0;
            // 精確在第三次讀取（操作前、操作後、最終驗證）重設，避免 timer 競速。
            element.getAttribute = name => {
                if (name === 'aria-checked' && ++reads === 3) {
                    element.querySelector('input')!.checked = false;
                    element.removeAttribute('aria-checked');
                }
                return original(name);
            };
        });
        await assert.rejects(new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 2, adjacent: true }, 4880), /最終相連座位設定不一致/);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});
