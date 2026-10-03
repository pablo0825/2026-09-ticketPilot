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
    constructor(private readonly page: Page, private readonly timeout = 10_000) {
        // 建立定位器
        // .locator 指定檢查哪個元素
        this.root = page.locator(selectors.root);
    }

    async selectAndVerify(target: TicketTarget, expectedUnitPrice: number): Promise<void> {
        // 檢查票券格式是否符合
        validateTicketTarget(target);
        if (!Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice <= 0) {
            throw new PurchaseStop("預期單價必須是正整數。");
        }
        // 確認票券選擇區只有一個元素
        await this.waitForUniqueElement(this.root, "票券選擇區");

        // 
        const date = await this.selectDate(target.date);
        const time = await this.selectTime(target.time);
        const area = await this.selectArea(target.area, expectedUnitPrice);
        await this.setQuantity(target.quantity);
        await this.setAdjacentPreference(target);

        // 操作完再讀一次，確保後面的操作沒有重設前面的選擇。
        await this.verifySelectedOption(date, "日期");
        await this.verifySelectedOption(time, "時間");
        await this.verifySelectedOption(area, "票區");
        const matched = await this.findArea(target.area, expectedUnitPrice);
        await this.verifySelectedOption(matched, "票區");
        await this.verifyQuantity(target.quantity);
        await this.verifyAdjacentPreference(target);

        log("選票驗證完成，目前尚未取得座位。");
    }

    // 找到並選中日期，最後回傳定位器
    private async selectDate(date: string): Promise<Locator> {
        // 2026-09-05 變成 [2026, 9, 5]
        // .split() 切個字串
        // 轉為 map，並轉換型別為 Number
        const [year, month, day] = date.split("-").map(Number);
        // 建立文字比對規則
        const fullDate = new RegExp(`${year}\\s*年\\s*0?${month}\\s*月\\s*0?${day}\\s*日`);
        // 取得頁面日期
        const pageText = await this.page.locator("body").innerText();

        // 選項只有月日，因此另外從活動資訊核對年份。
        if (!fullDate.test(pageText)) {
            throw new Error("活動頁未能確認目標完整日期（含年份），已停止。");
        }

        const label = new RegExp(`^\\s*${month}月${day}日[（(]週.[）)]\\s*$`);

        return this.selectOption("日期", label);
    }

    private selectTime(time: string): Promise<Locator> {
        return this.selectOption("時間", new RegExp(`^\\s*${escapeRegex(time)}\\s*$`));
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

    private async selectArea(area: string, expectedUnitPrice: number): Promise<Locator> {
        const option = await this.findArea(area, expectedUnitPrice);
        if (!await this.isSelected(option)) {
            await option.click({ timeout: this.timeout });
            await this.waitUntil(() => this.isSelected(option), "票種點選後沒有確認選中");
        }
        log(`票種已選：${(await option.innerText()).trim()}`);
        return option;
    }

    // 找到群組中的選項，並回傳定位器
    private async selectOption(groupName: string, label: RegExp): Promise<Locator> {
        // 找到群組標題
        // hasText 依照文字內容篩選
        const heading = this.page.locator(selectors.groupName).filter({
            hasText: new RegExp(`^${escapeRegex(groupName)}\\s*$`),
        });
        // 找到該標題的群組
        // 在 root 裡，找到該標題的群組
        // has 按照指定元素篩選
        const group = this.root.locator(selectors.group).filter({ has: heading });
        await this.waitForUniqueElement(group, `${groupName}群組`);

        // 在群組中找到目標
        const option = group.locator(selectors.option).filter({ hasText: label });
        await this.waitForUniqueElement(option, `${groupName}選項`);

        // 選項沒有已選中的 css，才去點它
        if (!await this.isSelected(option)) {
            // 點擊選項 (返回 boolean)
            await option.click({ timeout: this.timeout });
            // 反覆檢查選項是否被選中
            await this.waitUntil(() => this.isSelected(option), `${groupName}點選後沒有確認選中`);
        }

        log(`${groupName}已選：${(await option.innerText()).trim()}`);

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
        await checkbox.setChecked(target.adjacent, { timeout: this.timeout });
        await this.waitUntil(async () =>
            await checkbox.getAttribute("aria-checked") === String(target.adjacent),
            "相連座位設定未更新");
    }

    private async verifySelectedOption(option: Locator, name: string): Promise<void> {
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
        const checked = await this.root.locator(selectors.adjacent).getAttribute("aria-checked");
        if (checked !== String(target.adjacent)) throw new Error("最終相連座位設定不一致。");
    }

    private isSelected(option: Locator): Promise<boolean> {
        // .evaluate 在瀏覽器中執行函式
        return option.evaluate((element, className) =>
            // 檢查 css 清單有沒有包含 className
            element.classList.contains(className), selectors.selectedClass);
    }

    // 等待唯一的可見元素(就是定義要找網頁中的哪一個區塊)
    private async waitForUniqueElement(locator: Locator, name: string): Promise<void> {
        await this.waitUntil(async () => {
            // 取得符合條件的元素數量
            const count = await locator.count();

            if (count > 1) throw new Error(`${name} 有多個匹配項，為避免誤選已停止。`);

            // 剛好一個元素，而且可見，才回傳 true
            // .isVisible() 檢查已定位的元素是否可見
            return count === 1 && await locator.isVisible();
        }, `找不到唯一可見的${name}`);
    }

    // 期限內反覆檢查
    // check 回傳 true, false
    private async waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
        // 從現在起約 10 秒
        const deadline = Date.now() + this.timeout;

        // 時間還沒到就繼續檢查
        while (Date.now() < deadline) {
            // check 為 true 結束，為 false 繼續執行
            if (await check()) return;

            // 只等待 DOM 更新，不刷新網頁。
            // 暫停 200 毫秒
            await this.page.waitForTimeout(200);
        }

        throw new Error(`${message}；狀態未知，已停止，未判定售罄。`);
    }
}
