import type { Page } from "playwright";
import { validateContactDetails, type ContactDetails } from "../../config/contact.config.js";

export class KlookContactForm {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 10_000) {}

    async fillAndVerify(input: ContactDetails): Promise<void> {
        const details = validateContactDetails(input);
        try {
            await this.assertAvailable();
            await this.selectRegion(details.regionLabel);
            const fields = [
                { selector: '.os_traveler_info__name input[placeholder="請填寫名字"]', value: details.firstName },
                { selector: '.os_traveler_info__name input[placeholder="請填寫姓氏"]', value: details.lastName },
                { selector: '.os_traveler_info__phone input[placeholder="請填寫手機號碼"]', value: details.phone },
                { selector: '.os_traveler_info__email input[placeholder="請輸入"]', value: details.email },
            ];
            for (const field of fields) {
                await this.assertAvailable();
                const input = this.page.locator(field.selector);
                await input.fill(field.value, { timeout: this.timeout });
                await input.blur({ timeout: this.timeout });
            }
            await this.assertAvailable();
            for (const field of fields) {
                if (await this.page.locator(field.selector).inputValue({ timeout: this.timeout }) !== field.value) {
                    throw new Error("欄位核對失敗");
                }
            }
            const region = this.page.locator('.os_traveler_info__region_code input[placeholder="請選擇"]');
            if (await region.inputValue({ timeout: this.timeout }) !== details.regionLabel) throw new Error("區碼核對失敗");
            const errors = this.page.locator('.klk-form-item-error, .klk-form-item-is-error, [aria-invalid="true"]').filter({ visible: true });
            if (await errors.count() > 0) throw new Error("表單顯示錯誤");
        } catch {
            // Playwright 的原始錯誤可能包含 fill 的輸入值，不向外傳遞或記錄。
            throw new Error("聯絡資料填寫或核對未完成，請人工檢查欄位、格式提示或逾時彈窗；未提交。");
        }
    }

    private async selectRegion(label: string): Promise<void> {
        const group = this.page.locator(".os_traveler_info__region_code");
        const input = group.locator('input[placeholder="請選擇"]');
        if (await input.inputValue({ timeout: this.timeout }) === label) return;
        await group.locator(".klk-select-reference").click({ timeout: this.timeout });
        const option = group.locator(".klk-option").filter({ has: this.page.getByText(label, { exact: true }) });
        // 限定完整選項文字，不用模糊的國碼匹配。
        await option.click({ timeout: this.timeout });
        await option.and(group.locator(".klk-option-selected")).waitFor({ state: "attached", timeout: this.timeout });
    }

    private async assertAvailable(): Promise<void> {
        const current = new URL(this.page.url());
        if (current.origin !== new URL(this.eventUrl).origin || current.pathname !== "/zh-TW/event/payment/") throw new Error("已離開個人資料頁");
        if (await this.page.locator(".klk-modal").filter({ visible: true }).count() > 0) throw new Error("有彈窗");
        if (!await this.page.getByRole("heading", { name: "聯絡資料", exact: true }).isVisible()) throw new Error("聯絡資料未就緒");
    }
}
