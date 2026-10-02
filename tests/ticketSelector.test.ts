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
    return `<p>活動日期｜2026 年 10 月 03 日（六）</p><div id="ticket-options">
        ${group("日期", ["10月3日(週六)"], 0)}
        ${group("時間", ["12:00", "18:00"], 1)}
        ${group("票種", ["A區（NT$4,880）", "A區愛心席（NT$2,440）", "B區（NT$3,880）"], 2)}
        <div class="eventUnit-kxDycC"><div class="counter-vVrWZ9">
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_minus_xs">−</i></div>
          <div class="value-xWKzpL">${initialQuantity}</div>
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_plus_xs">＋</i></div>
        </div><div>最多4張</div></div>
        <div class="consecutive"><span role="checkbox" tabindex="0" aria-checked="true">相連座位</span></div>
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
        checkbox.onclick = () => checkbox.setAttribute('aria-checked', String(checkbox.getAttribute('aria-checked') !== 'true'));
        })();</script>`;
}

test("選 A 區一張、保留不適用的連票設定並停在下一步之前；重跑不累加", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 800);
        await adapter.selectAndVerify(target);
        await adapter.selectAndVerify(target);
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
        await new KlookTicketSelector(page, 800).selectAndVerify(target);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "1");
    } finally { await page.close(); }
});

test("單張票沒有連票元件也可通過；多張仍驗證連票設定", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator('.consecutive').evaluate(el => el.remove());
        await new KlookTicketSelector(page, 800).selectAndVerify(target);
        await page.setContent(fixture());
        await new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 2 });
        assert.equal(await page.locator('[role=checkbox]').getAttribute('aria-checked'), "false");
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("超過 UI 上限停止，不點下一步", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await assert.rejects(new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 5 }), /超過 UI 上限/);
        assert.equal(await page.locator('.value-xWKzpL').innerText(), "0");
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("點擊未生效時不宣告成功", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture(0, true));
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /點選後沒有確認選中/);
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
            await assert.rejects(adapter.selectAndVerify(invalid));
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
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /多個匹配項/);
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
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /數量按鈕目前停用/);
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
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /票區最終驗證不一致/);
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});

test("多張票的连票勾選未生效時仍然失敗", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture().replace("checkbox.onclick = () => checkbox.setAttribute('aria-checked', String(checkbox.getAttribute('aria-checked') !== 'true'));", "checkbox.onclick = () => {};"));
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify({ ...target, quantity: 2 }));
        assert.equal(await page.locator('body').getAttribute('data-next'), null);
    } finally { await page.close(); }
});
