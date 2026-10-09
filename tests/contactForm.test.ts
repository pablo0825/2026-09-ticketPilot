import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { validateContactDetails } from "../src/config/contact.config.js";
import { KlookContactForm } from "../src/platforms/klook/contactForm.js";
const data = {
    firstName: "測試",
    lastName: "範例",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "test@example.test",
};
const url = "https://www.klook.com/zh-TW/event/payment/";
const fixture = `<h2>聯絡資料</h2>
<div class="os_traveler_info__region_code"><div class="klk-select-reference"><input placeholder="請選擇" readonly value="香港 (+852)"></div><div class="klk-option" onclick="this.classList.add('klk-option-selected');document.querySelector('[placeholder=請選擇]').value='台灣 (+886)'"><span class="klk-option-label">台灣 (+886)</span></div></div>
<div class="os_traveler_info__name"><input placeholder="請填寫名字"></div><div class="os_traveler_info__name"><input placeholder="請填寫姓氏"></div><div class="os_traveler_info__phone"><input placeholder="請填寫手機號碼"></div><div class="os_traveler_info__email"><input placeholder="請輸入"></div>
<input type="checkbox" checked><button onclick="document.body.dataset.submitted='true'">前往付款</button>`;

test("本機個資設定拒絕缺欄或錯誤格式，錯誤不包含個資", () => {
    assert.deepEqual(validateContactDetails(data), data);
    assert.throws(
        () => validateContactDetails({ ...data, email: "private-invalid" }),
        error => error instanceof Error && !error.message.includes("private-invalid"),
    );
    assert.throws(() => validateContactDetails({ ...data, phone: "" }));
});

test("填寫並核對區碼與個資、不提交、不改偏好；彈窗或錯頁停止", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.route("**/*", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture }));
        await page.goto(url);
        const form = new KlookContactForm(page, "https://www.klook.com/zh-TW/event-detail/test/", 500);
        await form.fillAndVerify(data);
        assert.equal(await page.locator('[placeholder="請填寫名字"]').inputValue(), data.firstName);
        assert.equal(await page.locator("body").getAttribute("data-submitted"), null);
        assert.equal(await page.locator("[type=checkbox]").isChecked(), true);
        await page.setContent(fixture + '<div class="klk-modal">已過期</div>');
        await assert.rejects(form.fillAndVerify(data), /未提交/);
        assert.equal(await page.locator('[placeholder="請填寫名字"]').inputValue(), "");
        await page.setContent(fixture.replace('placeholder="請填寫手機號碼"', 'placeholder="缺少欄位"'));
        await assert.rejects(
            form.fillAndVerify(data),
            error => error instanceof Error && !error.message.includes(data.phone),
        );
        await page.goto("https://example.test/zh-TW/event/payment/");
        await assert.rejects(form.fillAndVerify(data), /未提交/);
    } finally {
        await browser.close();
    }
});

test("Zod 保留 trim 與忽略額外欄位，拒絕錯誤型別且不洩漏輸入", () => {
    assert.deepEqual(validateContactDetails({ ...data, firstName: "  測試  ", extra: "不保留" }), data);
    for (const invalid of [
        null,
        [],
        "secret-input",
        { ...data, firstName: 123 },
        { ...data, email: "private-invalid" },
        { ...data, regionLabel: "" },
    ]) {
        assert.throws(
            () => validateContactDetails(invalid),
            error =>
                error instanceof Error &&
                !error.message.includes("private-invalid") &&
                !error.message.includes("secret-input"),
        );
    }
});
