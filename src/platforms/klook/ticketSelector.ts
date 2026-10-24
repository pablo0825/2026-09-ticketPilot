import { waitForTicketOptions, pollSelection, selectionWaitTimeout } from "./selectionPolling.js";
import { clickTargetOption, findTargetOption, verifySelectedTarget } from "./selectionOptions.js";
import type { TargetGroup } from "./selectionOptions.js";
import { KlookTicketExtras } from "./ticketExtras.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { validateTicketTarget } from "../../core/purchaseValidation.js";
import type { Locator, Page } from "playwright";
import type { TicketTarget, TicketOptions } from "../../core/types.js";
import { log } from "../../core/logger.js";

// Klook 改版時，優先檢查這裡的定位方式。
const selectors = {
    root: "#ticket-options",
    ticketRow: ".eventUnit-kxDycC",
    counter: ".counter-vVrWZ9",
    quantity: ".value-xWKzpL",
    quantityButton: ".btn-vDH5IS",
    disabledClass: "btnDisabled-O7fKf4",
    plusIcon: ".klk-icon-icon_other_plus_xs",
    minusIcon: ".klk-icon-icon_other_minus_xs",
    adjacent: '.consecutive [role="checkbox"]',
};

export class KlookTicketSelector {
    private readonly root: Locator;

    constructor(
        private readonly page: Page,
        private readonly timeout = selectionWaitTimeout,
        private readonly observeSelectionNotice: () => Promise<void> = async () => {},
    ) {
        this.root = page.locator(selectors.root);
    }

    async selectAndVerify(target: TicketTarget, options: TicketOptions = {}): Promise<"selected" | "disabled"> {
        validateTicketTarget(target);
        await waitForTicketOptions(this.page, this.observeSelectionNotice, this.timeout);

        // 收集完成後依序操作；下游停用前仍核對已選好的上游條件。
        if (!(await this.selectGroup("日期", target.date))) return "disabled";
        if (!(await this.selectGroup("時間", target.time))) {
            await this.verifyGroup("日期", target.date);
            return "disabled";
        }
        if (!(await this.selectGroup("票種", target.area))) {
            await this.verifyGroup("日期", target.date);
            await this.verifyGroup("時間", target.time);
            return "disabled";
        }

        const extras = new KlookTicketExtras(this.page, target, options, this.timeout, this.observeSelectionNotice);
        await extras.select();
        await this.setQuantity(target.quantity);
        await this.setAdjacentPreference(target);

        // 同批替換操作與最終核對，後續操作不得默默重設已選項目。
        await this.verifyGroup("日期", target.date);
        await this.verifyGroup("時間", target.time);
        await this.verifyGroup("票種", target.area);
        await this.verifyQuantity(target.quantity);
        await this.verifyAdjacentPreference(target);
        await extras.verify();
        log("選票驗證完成，目前尚未取得座位。");
        return "selected";
    }

    private async selectGroup(name: TargetGroup, wanted: string): Promise<boolean> {
        const snapshot = await pollSelection(
            this.page,
            data => findTargetOption(data, name, wanted) !== undefined,
            `${name}資料尚未完整`,
            this.observeSelectionNotice,
            this.timeout,
        );
        const option = findTargetOption(snapshot, name, wanted);
        if (!option) throw new PurchaseStop(`${name}資料不完整。`);

        // 日期／時間沿用原停用規則；票種只有明確 disabled 才跳順位。
        if (option.disabled || (name !== "票種" && (option.soldOut || !option.enabled))) {
            if (option.selected || !option.disabled) throw new PurchaseStop(`${name}停用狀態不明或矛盾，已停止。`);
            log(`${name}目前不可選：${wanted}；未送出選票。`);
            return false;
        }
        if (!option.selected) {
            await this.observeSelectionNotice();
            await clickTargetOption(this.page, name, option, this.timeout);
            // 已嘗試點擊就只讀取，不因結果延遲再點一次。
            await pollSelection(
                this.page,
                data => findTargetOption(data, name, wanted)?.selected === true,
                `${name}點選後沒有確認選中`,
                this.observeSelectionNotice,
                this.timeout,
            );
        }
        await this.verifyGroup(name, wanted);
        log(`${name}已選：${wanted}${name === "日期" ? "；完整年份於配位確認前核對。" : ""}`);
        return true;
    }

    private async verifyGroup(name: TargetGroup, wanted: string): Promise<void> {
        await pollSelection(
            this.page,
            snapshot => {
                verifySelectedTarget(snapshot, name, wanted);
                return true;
            },
            `${name}最終資料尚未完整`,
            this.observeSelectionNotice,
            this.timeout,
        );
    }

    private async setQuantity(wanted: number): Promise<void> {
        // 等數量列與數量值出現
        const row = this.root.locator(selectors.ticketRow);
        await this.waitForUniqueElement(row, "票券數量列");
        await this.waitForUniqueElement(row.locator(selectors.quantity), "數量值");

        // 確認目標張數沒有超過上限
        const limit = (await row.innerText()).match(/最多\s*(\d+)\s*張/)?.[1];
        if (!limit) throw new Error("無法確認單次購買數量上限，已停止。");
        if (wanted > Number(limit)) throw new Error(`目標票數超過 UI 上限 ${limit} 張。`);

        // 一次按一下加或減，直到張數符合
        let current = await this.readQuantity();
        while (current !== wanted) {
            const increase = current < wanted;
            const icon = increase ? selectors.plusIcon : selectors.minusIcon;
            const button = row
                .locator(selectors.counter)
                .locator(selectors.quantityButton)
                .filter({ has: this.page.locator(icon) });
            await this.waitForUniqueElement(button, "數量按鈕");

            const disabled = await button.evaluate(
                (element, className) =>
                    element.classList.contains(className) || element.getAttribute("aria-disabled") === "true",
                selectors.disabledClass,
            );
            if (disabled) throw new Error("數量按鈕目前停用，無法設定目標票數。");

            const expected = current + (increase ? 1 : -1);
            await button.click({ timeout: this.timeout });
            await this.waitUntil(async () => (await this.readQuantity()) === expected, "數量點選後未更新");
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
        await this.waitUntil(
            async () => (await this.readAdjacentPreference()) === target.adjacent,
            "相連座位設定未更新",
        );
    }

    private async verifyQuantity(wanted: number): Promise<void> {
        if ((await this.readQuantity()) !== wanted) throw new PurchaseStop("最終票數不一致。");
    }

    private async verifyAdjacentPreference(target: TicketTarget): Promise<void> {
        if (target.quantity === 1) return;

        const checked = await this.readAdjacentPreference();
        if (checked !== target.adjacent) throw new PurchaseStop("最終相連座位設定不一致。");
    }

    private async readAdjacentPreference(): Promise<boolean> {
        const checkbox = this.root.locator(selectors.adjacent);
        if ((await checkbox.count()) !== 1 || !(await checkbox.isVisible())) {
            throw new PurchaseStop("找不到唯一可見的相連座位設定，已停止。");
        }

        const checked = await checkbox.evaluate(element => {
            const inputs = element.querySelectorAll("input");
            const input = inputs[0];
            if (
                inputs.length !== 1 ||
                !(input instanceof HTMLInputElement) ||
                input.type !== "checkbox" ||
                input.indeterminate
            ) {
                return null;
            }

            // 客製控制項的 input 可以隱藏；取消勾選時 Klook 會移除外層 ARIA 屬性。
            const aria = element.getAttribute("aria-checked");
            const consistent = input.checked ? aria === "true" : aria === null || aria === "false";
            return consistent ? input.checked : null;
        });

        if (checked === null) throw new PurchaseStop("相連座位元件結構或勾選狀態不明確，已停止。");
        return checked;
    }

    // 等待唯一的可見元素(就是定義要找網頁中的哪一個區塊)
    private async waitForUniqueElement(locator: Locator, name: string, observe?: () => Promise<void>): Promise<void> {
        await this.waitUntil(
            async () => {
                // 取得符合條件的元素數量
                const count = await locator.count();

                if (count > 1) throw new Error(`${name} 有多個匹配項，為避免誤選已停止。`);

                // 剛好一個元素，而且可見，才回傳 true
                // .isVisible() 檢查已定位的元素是否可見
                return count === 1 && (await locator.isVisible());
            },
            `找不到唯一可見的${name}`,
            observe,
        );
    }

    // 期限內反覆檢查
    // check 回傳 true, false
    private async waitUntil(
        check: () => Promise<boolean>,
        message: string,
        observe?: () => Promise<void>,
    ): Promise<void> {
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
