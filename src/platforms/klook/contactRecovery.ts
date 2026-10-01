import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";
import { isEventPageReady } from "./eventPage.js";

const expiredMessage = /^未於時限內確認[，,]\s*票券預留失敗$/;

// 只由尚未提交的個人資料準備階段啟用，不處理選位或付款頁。
export class KlookContactRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private isContactPage(): boolean {
        const current = new URL(this.page.url());
        return current.origin === new URL(this.eventUrl).origin && current.pathname === "/zh-TW/event/payment/";
    }

    private expiredDialog(): Locator {
        return this.page.locator(".klk-modal-alert").filter({
            has: this.page.getByText(expiredMessage), visible: true,
        });
    }

    async isRequired(): Promise<boolean> {
        return this.isContactPage() && await this.expiredDialog().count() > 0;
    }

    async recover(): Promise<void> {
        if (!this.isContactPage() || await this.expiredDialog().count() !== 1) {
            throw new Error("無法確認唯一的個人資料逾期彈窗，已停止恢復。");
        }
        const confirm = this.expiredDialog().getByRole("button", { name: "確認", exact: true });
        if (await confirm.count() !== 1 || !await confirm.isVisible() || !await confirm.isEnabled()) {
            throw new Error("個人資料逾期彈窗的確認按鈕不唯一或無法操作。");
        }
        log("個人資料預留已過期：按一次彈窗確認，等待原活動頁恢復。");
        await confirm.click({ timeout: this.timeout });
        const deadline = Date.now() + this.timeout;
        while (Date.now() < deadline) {
            if (await isEventPageReady(this.page, this.eventUrl)) {
                log("已返回原活動頁，重新選票與配位；不沿用舊預留資料。");
                return;
            }
            await this.page.waitForTimeout(200);
        }
        throw new Error("確認逾期後未能恢復原活動選票區，已停止；不再次點擊或重整。");
    }
}
