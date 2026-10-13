import type { Locator, Page } from "playwright";
import type { TicketOptions, TicketTarget } from "../../core/types.js";
import { SelectionExpiryNotice } from "./notices.js";
import { PurchaseStop } from "../../core/purchaseStop.js";

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 只合併一般空白及套票編號前的空白，不合併數字或其他單字。
function normalizeName(text: string): string {
    return text
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/套票\s+(?=\d)/g, "套票");
}

export function matchesExtraName(actual: string, wanted: string): boolean {
    const name = normalizeName(actual);
    const prefix = normalizeName(wanted);
    if (!prefix || !name.startsWith(prefix)) return false;
    const rest = name.slice(prefix.length).trimStart();
    return !rest || /^[:(\-—]/.test(rest);
}

interface ExtraChoice {
    heading: string;
    wanted?: string;
    selectedText?: string;
    optionalGroup?: boolean;
    groupSeen?: boolean;
}

// 只處理選票頁的兩個額外群組，不改動票種或後續頁面核對。
export class KlookTicketExtras {
    private readonly choices: ExtraChoice[];

    constructor(
        private readonly page: Page,
        target: TicketTarget,
        options: TicketOptions,
        private readonly timeout: number,
        private readonly observeNotice: () => Promise<void>,
    ) {
        if (options.bundleEnabled && !target.bundle?.trim()) throw new PurchaseStop("請填寫組合套票名稱。");
        this.choices = [
            { heading: "組合套票", wanted: options.bundleEnabled ? target.bundle : undefined },
            { heading: "取票方式", wanted: options.deliveryMethod, optionalGroup: true },
        ];
    }

    async select(): Promise<void> {
        try {
            for (const choice of this.choices) {
                // 找到唯一候選，停用時停止而不切換順位
                const option = await this.findOption(choice);
                if (!option) continue;
                await this.assertAvailable(option, choice.heading);
                choice.selectedText = normalizeName(await option.innerText());

                // 只點一次，再重新定位並確認選中
                await this.observeNotice();
                if (!(await this.isSelected(option))) await option.click({ timeout: this.timeout });
                await this.waitForSelected(choice);
            }
        } catch (error) {
            if (error instanceof PurchaseStop || error instanceof SelectionExpiryNotice) throw error;
            throw new PurchaseStop("套票或取票方式狀態未知，已停止；不換順位。");
        }
    }

    async verify(): Promise<void> {
        try {
            for (const choice of this.choices) {
                const option = await this.findOption(choice);
                if (!option) continue;
                await this.verifyChoice(choice, option);
            }
        } catch (error) {
            if (error instanceof PurchaseStop || error instanceof SelectionExpiryNotice) throw error;
            throw new PurchaseStop("套票或取票方式狀態未知，已停止；不換順位。");
        }
    }

    private group(heading: string): Locator {
        const title = this.page.locator(".name-Cu4gxk").filter({
            hasText: new RegExp(`^\\s*${escapeRegex(heading)}\\s*(?:[（(][^()（）]*[）)])?\\s*$`),
        });
        return this.page.locator("#ticket-options .skuGroup-hk2pfU").filter({ has: title, visible: true });
    }

    private async findOption(choice: ExtraChoice): Promise<Locator | null> {
        const deadline = Date.now() + this.timeout;
        while (Date.now() < deadline) {
            // 每次等待都保留既有的過期偵測
            await this.observeNotice();
            const group = this.group(choice.heading);
            const count = await group.count();
            if (count > 0) choice.groupSeen = true;
            if (count === 0 && choice.optionalGroup && !choice.groupSeen) return null;
            if (count > 1) throw new PurchaseStop(`${choice.heading}群組不唯一，已停止。`);
            if (!choice.wanted) {
                if (count) throw new PurchaseStop(`頁面出現${choice.heading}，請先完成設定。`);
                return null;
            }

            // 先檢查所有可見候選，包含停用項，避免隱藏歧義
            if (count === 1) {
                const options = group.locator(".spec-LwNjSh").filter({ visible: true });
                const texts = await options.allTextContents();
                const matches = texts.filter(text => matchesExtraName(text, choice.wanted!));
                if (matches.length > 1) throw new PurchaseStop(`${choice.heading}有多個匹配選項，請填寫更完整的名稱。`);
                if (matches.length === 1) {
                    return options.filter({ hasText: new RegExp(`^\\s*${escapeRegex(matches[0]!.trim())}\\s*$`) });
                }
            }
            await this.page.waitForTimeout(100);
        }
        throw new PurchaseStop(`找不到唯一符合的${choice.heading}：${choice.wanted}；未判定售罄。`);
    }

    private async assertAvailable(option: Locator, heading: string): Promise<void> {
        const unavailable = await option.evaluate(
            el => el.classList.contains("disabled-ImixBj") || el.classList.contains("soldout-sBHQQa"),
        );
        if (unavailable) throw new PurchaseStop(`${heading}目前無法選取，已停止；不換順位。`);
    }

    private isSelected(option: Locator): Promise<boolean> {
        return option.evaluate(el => el.classList.contains("active-vB3nra"));
    }

    private async verifyChoice(choice: ExtraChoice, option: Locator): Promise<void> {
        await this.assertAvailable(option, choice.heading);
        if (normalizeName(await option.innerText()) !== choice.selectedText) {
            throw new PurchaseStop(`${choice.heading}選項內容已改變，已停止。`);
        }
        const selected = this.group(choice.heading).locator(".spec-LwNjSh.active-vB3nra").filter({ visible: true });
        if ((await selected.count()) !== 1 || !(await this.isSelected(option))) {
            throw new PurchaseStop(`${choice.heading}選取結果不一致，已停止。`);
        }
    }

    private async waitForSelected(choice: ExtraChoice): Promise<void> {
        const deadline = Date.now() + this.timeout;
        while (Date.now() < deadline) {
            const option = await this.findOption(choice);
            if (!option) throw new PurchaseStop(`${choice.heading}消失，已停止。`);
            await this.assertAvailable(option, choice.heading);
            if (await this.isSelected(option)) {
                await this.verifyChoice(choice, option);
                return;
            }
            await this.page.waitForTimeout(100);
        }
        throw new PurchaseStop(`${choice.heading}點選後沒有確認選中，已停止。`);
    }
}
