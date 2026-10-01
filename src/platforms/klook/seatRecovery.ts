import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";
import { waitForEventPage } from "./eventPage.js";

const expiredMessage = /^未於時限內確認[，,]\s*票券預留失敗$/;

// 由流程協調層限定於尚未嘗試座位確認的階段。
export class KlookSeatRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private isEventPage(): boolean {
        const current = new URL(this.page.url());
        const expected = new URL(this.eventUrl);
        return current.origin === expected.origin && current.pathname === expected.pathname;
    }

    private expiredDialog(): Locator {
        return this.page.locator(".klk-modal-alert").filter({
            has: this.page.getByText(expiredMessage), visible: true,
        });
    }

    async isRequired(): Promise<boolean> {
        return this.isEventPage() &&
            await this.page.locator(".main_right-ZMnX67").filter({ visible: true }).count() === 1 &&
            await this.expiredDialog().count() > 0;
    }

    async recover(returnQueueRecovery?: FlowRecovery): Promise<void> {
        if (!await this.isRequired() || await this.expiredDialog().count() !== 1 ||
            await this.page.locator(".klk-modal-alert").filter({ visible: true }).count() !== 1) {
            throw new Error("無法確認唯一的選位逾期彈窗，已停止恢復。");
        }
        const ok = this.expiredDialog().getByRole("button", { name: "OK", exact: true });
        if (await ok.count() !== 1 || !await ok.isVisible() || !await ok.isEnabled()) {
            throw new Error("選位逾期彈窗的 OK 按鈕不唯一或無法操作。");
        }
        log("選位預留已過期：按一次 OK，等待原活動選票區恢復。");
        await ok.click({ timeout: this.timeout });
        await waitForEventPage(this.page, this.eventUrl, this.timeout,
            "選位逾期按 OK 後未能恢復選票入口，已停止；不再次點擊或重整。", returnQueueRecovery);
        log("選票入口已恢復，重新核對選票條件並取得新座位。");
    }
}
