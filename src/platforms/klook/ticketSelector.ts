import { SelectionExpiryNotice } from "./notices.js";
import { parseDateOption, matchesDateOption } from "./eventDate.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { normalizeTicketName, parseTicketLabel } from "./ticketLabel.js";
import { validateTicketTarget } from "../../core/purchaseValidation.js";
import type { Locator, Page } from "playwright";
import type { TicketTarget } from "../../core/types.js";
import { log } from "../../core/logger.js";

// Klook 改版時，優先檢查這裡的定位方式。
const selectors = {
    root: "#ticket-options",
    group: ".skuGroup-hk2pfU",
    groupName: ".name-Cu4gxk",
    option: ".spec-LwNjSh",
    disabledOptionClass: "disabled-ImixBj",
    selectedClass: "active-vB3nra",
    ticketRow: ".eventUnit-kxDycC",
    counter: ".counter-vVrWZ9",
    quantity: ".value-xWKzpL",
    quantityButton: ".btn-vDH5IS",
    disabledClass: "btnDisabled-O7fKf4",
    plusIcon: ".klk-icon-icon_other_plus_xs",
    minusIcon: ".klk-icon-icon_other_minus_xs",
    adjacent: '.consecutive [role="checkbox"]',
};

// 把設定中的文字當成一般文字比對，避免括號等符號被當作正規表示式。
function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Klook 票務選擇器
export class KlookTicketSelector {
    // 儲存票卷選擇區的定位器
    // Locator Playwright 用來定位網頁元素的物件
    private readonly root: Locator;

    // page, timeout 作為物件的私有屬性
    constructor(private readonly page: Page, private readonly timeout = 10_000,
        private readonly observeSelectionNotice: () => Promise<void> = async () => {}) {
        // 建立定位器
        // .locator 指定檢查哪個元素
        this.root = page.locator(selectors.root);
    }

    async selectAndVerify(target: TicketTarget, expectedUnitPrice: number): Promise<"selected" | "disabled"> {
        // 檢查票券格式是否符合
        validateTicketTarget(target);
        if (!Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice <= 0) {
            throw new PurchaseStop("預期單價必須是正整數。");
        }
        // 確認票券選擇區只有一個元素
        await this.waitForUniqueElement(this.root, "票券選擇區");

        if (!await this.selectDate(target.date)) {
            log(`日期目前不可選：${target.date}；未送出選票。`);
            return "disabled";
        }
        const time = await this.selectTime(target.time);
        if (!time) {
            await this.verifyDate(target.date);
            log(`時間目前不可選：${target.date} ${target.time}；未送出選票。`);
            return "disabled";
        }
        const area = await this.selectArea(target.area, expectedUnitPrice);
        if (!area) {
            await this.verifyDate(target.date);
            await this.verifySelectedOption(time, "時間");
            log(`票種目前停用：${target.area} / ${expectedUnitPrice}；未送出選票。`);
            return "disabled";
        }
        await this.setQuantity(target.quantity);
        await this.setAdjacentPreference(target);

        // 操作完再讀一次，確保後面的操作沒有重設前面的選擇。
        await this.verifyDate(target.date);
        await this.verifySelectedOption(time, "時間");
        if (await this.isDisabled(area)) throw new PurchaseStop("選票操作後票種變為停用，已停止；不送出。");
        await this.verifySelectedOption(area, "票區");
        const matched = await this.findArea(target.area, expectedUnitPrice);
        await this.verifySelectedOption(matched, "票區");
        if (await this.isDisabled(matched)) throw new PurchaseStop("選票操作後票種變為停用，已停止；不送出。");
        await this.verifyQuantity(target.quantity);
        await this.verifyAdjacentPreference(target);

        log("選票驗證完成，目前尚未取得座位。");
        return "selected";
    }

    private async findDate(expected: string): Promise<Locator> {
        try {
            const heading = this.page.locator(selectors.groupName).filter({ hasText: /^日期\s*$/ });
            const group = this.root.locator(selectors.group).filter({ has: heading });
            await this.observeSelectionNotice();
            await this.waitForUniqueElement(group, "日期群組", this.observeSelectionNotice);
            const options = group.locator(selectors.option).filter({ visible: true });
            await this.waitUntil(async () => await options.count() > 0, "日期選項尚未載入", this.observeSelectionNotice);
            const labels = await options.allInnerTexts();
            const matches = labels.filter(label => matchesDateOption(parseDateOption(label), expected));
            if (matches.length !== 1) throw new PurchaseStop("日期選項不符合或有多個匹配項，已停止。");
            // 依文字重新定位，不保留 nth 索引，避免 DOM 重排後指向另一日期。
            const option = options.filter({ hasText: new RegExp(`^${escapeRegex(matches[0]!)}$`) });
            await this.waitForUniqueElement(option, "日期選項", this.observeSelectionNotice);
            if (!matchesDateOption(parseDateOption(await option.innerText()), expected)) {
                throw new PurchaseStop("日期選項已變動，已停止。");
            }
            return option;
        } catch (error) {
            if (error instanceof PurchaseStop || error instanceof SelectionExpiryNotice) throw error;
            throw new PurchaseStop("日期選項狀態未知，已停止；不換票種或重啟購票。");
        }
    }

    private async selectDate(expected: string): Promise<boolean> {
        try {
            const option = await this.findDate(expected);
            if (await this.isUnavailableSessionOption(option, "日期")) return false;
            if (!await this.isSelected(option)) {
                await option.click({ timeout: this.timeout });
                await this.waitUntil(() => this.isSelected(option), "日期點選後沒有確認選中", this.observeSelectionNotice);
            }
            await this.verifyDate(expected);
            log(`日期選項已選：${(await option.innerText()).trim()}；完整年份於配位確認前核對。`);
            return true;
        } catch (error) {
            if (error instanceof PurchaseStop || error instanceof SelectionExpiryNotice) throw error;
            throw new PurchaseStop("日期選取結果未知，已停止；不換票種或重啟購票。");
        }
    }

    private async verifyDate(expected: string): Promise<void> {
        await this.verifySelectedOption(await this.findDate(expected), "日期");
    }

    // 只有初次選擇時才回報不可選；BOYFRIEND 時間停用僅有 disabled class。
    private async isUnavailableSessionOption(option: Locator, name: string): Promise<boolean> {
        const state = await option.evaluate(el => ({
            disabled: el.classList.contains("disabled-ImixBj"),
            soldout: el.classList.contains("soldout-sBHQQa"),
            selected: el.classList.contains("active-vB3nra"),
        }));
        if (state.disabled || state.soldout || !await option.isEnabled()) {
            if (state.selected || !state.disabled) {
                throw new PurchaseStop(`${name}停用狀態不明或矛盾，已停止。`);
            }
            return true;
        }
        return false;
    }

    private async selectTime(time: string): Promise<Locator | null> {
        try {
            const heading = this.page.locator(selectors.groupName).filter({ hasText: /^時間\s*$/ });
            const group = this.root.locator(selectors.group).filter({ has: heading });
            await this.waitForUniqueElement(group, "時間群組", this.observeSelectionNotice);
            const option = group.locator(selectors.option).filter({ visible: true,
                hasText: new RegExp(`^\\s*${escapeRegex(time)}\\s*$`) });
            await this.waitForUniqueElement(option, "時間選項", this.observeSelectionNotice);
            if (await this.isUnavailableSessionOption(option, "時間")) return null;
            if (!await this.isSelected(option)) {
                await option.click({ timeout: this.timeout });
                await this.waitUntil(() => this.isSelected(option), "時間點選後沒有確認選中", this.observeSelectionNotice);
            }
            await this.verifySelectedOption(option, "時間");
            log(`時間已選：${(await option.innerText()).trim()}`);
            return option;
        } catch (error) {
            if (error instanceof PurchaseStop || error instanceof SelectionExpiryNotice) throw error;
            throw new PurchaseStop(`時間選項狀態未知，已停止；不換順位或重啟購票。${error instanceof Error ? error.message : ""}`);
        }
    }

    private async findArea(area: string, expectedUnitPrice: number): Promise<Locator> {
        const heading = this.page.locator(selectors.groupName).filter({ hasText: /^票種\s*$/ });
        const group = this.root.locator(selectors.group).filter({ has: heading });
        // 此處失敗是無法確認購買目標，不可被解讀為售罄或啟用恢復。
        try {
            await this.waitForUniqueElement(group, "票種群組");
            const options = group.locator(selectors.option).filter({ visible: true });
            await this.waitUntil(async () => await options.count() > 0, "票種尚未載入");
            const matches: Locator[] = [];
            let sameName = false;
            for (const option of await options.all()) {
                const parsed = parseTicketLabel(await option.innerText());
                if (parsed.name !== normalizeTicketName(area)) continue;
                sameName = true;
                if (parsed.unitPrice === expectedUnitPrice) matches.push(option);
            }
            if (matches.length > 1) throw new Error("票種有多個匹配項，已停止。");
            if (matches.length === 0) {
                throw new Error(sameName ? "票種單價不符，已停止。" : "找不到符合完整名稱與單價的票種，狀態未知，未判定售罄。");
            }
            return matches[0]!;
        } catch (error) {
            throw new PurchaseStop(error instanceof Error ? error.message : "無法核對票種與單價。");
        }
    }

    private async selectArea(area: string, expectedUnitPrice: number): Promise<Locator | null> {
        const option = await this.findArea(area, expectedUnitPrice);
        if (await this.isDisabled(option)) {
            if (await this.isSelected(option)) throw new PurchaseStop("票種同時為已選取與停用，狀態矛盾，已停止。");
            return null;
        }
        if (!await this.isSelected(option)) {
            await option.click({ timeout: this.timeout });
            await this.waitUntil(() => this.isSelected(option), "票種點選後沒有確認選中");
        }
        log(`票種已選：${(await option.innerText()).trim()}`);
        return option;
    }

    private async setQuantity(wanted: number): Promise<void> {
        const row = this.root.locator(selectors.ticketRow);
        await this.waitForUniqueElement(row, "票券數量列");
        await this.waitForUniqueElement(row.locator(selectors.quantity), "數量值");

        const limit = (await row.innerText()).match(/最多\s*(\d+)\s*張/)?.[1];
        if (!limit) throw new Error("無法確認單次購買數量上限，已停止。");
        if (wanted > Number(limit)) throw new Error(`目標票數超過 UI 上限 ${limit} 張。`);

        let current = await this.readQuantity();
        while (current !== wanted) {
            const increase = current < wanted;
            const icon = increase ? selectors.plusIcon : selectors.minusIcon;
            const button = row.locator(selectors.counter).locator(selectors.quantityButton)
                .filter({ has: this.page.locator(icon) });
            await this.waitForUniqueElement(button, "數量按鈕");

            const disabled = await button.evaluate((element, className) =>
                element.classList.contains(className) || element.getAttribute("aria-disabled") === "true",
                selectors.disabledClass);
            if (disabled) throw new Error("數量按鈕目前停用，無法設定目標票數。");

            const expected = current + (increase ? 1 : -1);
            await button.click({ timeout: this.timeout });
            await this.waitUntil(async () => await this.readQuantity() === expected, "數量點選後未更新");
            current = expected;
        }
        log(`票數已設為 ${current}`);
    }

    private async readQuantity(): Promise<number> {
        const text = (await this.root.locator(selectors.ticketRow).locator(selectors.quantity).innerText()).trim();
        if (!/^\d+$/.test(text)) throw new Error(`無法讀取數量：${text}`);
        return Number(text);
    }

    private async setAdjacentPreference(target: TicketTarget): Promise<void> {
        if (target.quantity === 1) {
            log("單張票不適用相連座位條件，保留頁面原設定。");
            return;
        }
        const checkbox = this.root.locator(selectors.adjacent);
        await this.waitForUniqueElement(checkbox, "相連座位設定");
        await this.readAdjacentPreference();
        await checkbox.setChecked(target.adjacent, { timeout: this.timeout });
        await this.waitUntil(async () =>
            await this.readAdjacentPreference() === target.adjacent,
            "相連座位設定未更新");
    }

    private async verifySelectedOption(option: Locator, name: string): Promise<void> {
        if (await this.isDisabled(option) || !await option.isEnabled() ||
            await option.evaluate(el => el.classList.contains("soldout-sBHQQa"))) {
            throw new PurchaseStop(`${name}最終驗證發現停用，已停止；不換順位。`);
        }
        const siblings = option.locator("..");
        const selectedCount = await siblings.locator(`${selectors.option}.${selectors.selectedClass}`).count();
        if (!await this.isSelected(option) || selectedCount !== 1) {
            throw new PurchaseStop(`${name}最終驗證不一致。`);
        }
    }

    private async verifyQuantity(wanted: number): Promise<void> {
        if (await this.readQuantity() !== wanted) throw new PurchaseStop("最終票數不一致。");
    }

    private async verifyAdjacentPreference(target: TicketTarget): Promise<void> {
        if (target.quantity === 1) return;
        const checked = await this.readAdjacentPreference();
        if (checked !== target.adjacent) throw new PurchaseStop("最終相連座位設定不一致。");
    }

    private async readAdjacentPreference(): Promise<boolean> {
        const checkbox = this.root.locator(selectors.adjacent);
        if (await checkbox.count() !== 1 || !await checkbox.isVisible()) {
            throw new PurchaseStop("找不到唯一可見的相連座位設定，已停止。");
        }
        const checked = await checkbox.evaluate(element => {
            const inputs = element.querySelectorAll("input");
            const input = inputs[0];
            if (inputs.length !== 1 || !(input instanceof HTMLInputElement)
                || input.type !== "checkbox" || input.indeterminate) return null;
            // 客製控制項的 input 可以隱藏；取消勾選時 Klook 會移除外層 ARIA 屬性。
            const aria = element.getAttribute("aria-checked");
            const consistent = input.checked ? aria === "true" : aria === null || aria === "false";
            return consistent ? input.checked : null;
        });
        if (checked === null) throw new PurchaseStop("相連座位元件結構或勾選狀態不明確，已停止。");
        return checked;
    }

    private isDisabled(option: Locator): Promise<boolean> {
        return option.evaluate((element, className) => element.classList.contains(className), selectors.disabledOptionClass);
    }

    private isSelected(option: Locator): Promise<boolean> {
        // .evaluate 在瀏覽器中執行函式
        return option.evaluate((element, className) =>
            // 檢查 css 清單有沒有包含 className
            element.classList.contains(className), selectors.selectedClass);
    }

    // 等待唯一的可見元素(就是定義要找網頁中的哪一個區塊)
    private async waitForUniqueElement(locator: Locator, name: string, observe?: () => Promise<void>): Promise<void> {
        await this.waitUntil(async () => {
            // 取得符合條件的元素數量
            const count = await locator.count();

            if (count > 1) throw new Error(`${name} 有多個匹配項，為避免誤選已停止。`);

            // 剛好一個元素，而且可見，才回傳 true
            // .isVisible() 檢查已定位的元素是否可見
            return count === 1 && await locator.isVisible();
        }, `找不到唯一可見的${name}`, observe);
    }

    // 期限內反覆檢查
    // check 回傳 true, false
    private async waitUntil(check: () => Promise<boolean>, message: string, observe?: () => Promise<void>): Promise<void> {
        // 從現在起約 10 秒
        const deadline = Date.now() + this.timeout;

        // 時間還沒到就繼續檢查
        while (Date.now() < deadline) {
            // check 為 true 結束，為 false 繼續執行
            await observe?.();
            if (await check()) return;

            // 只等待 DOM 更新，不刷新網頁。
            // 暫停 200 毫秒
            await this.page.waitForTimeout(200);
        }

        throw new Error(`${message}；狀態未知，已停止，未判定售罄。`);
    }
}
