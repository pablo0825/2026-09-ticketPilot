import { expiredDialog, reservationExpiredMessage } from "./notices.js";
import { isPersonalInfoPage } from "./personalInfoPage.js";
import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";
import { waitForRecoveryReturn } from "./recoveryReturn.js";

// 只由尚未提交的個人資料準備階段啟用，不處理選位或付款頁。
export class KlookContactRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private expiredDialog(): Locator {
        return expiredDialog(this.page, reservationExpiredMessage);
    }

    async isRequired(): Promise<boolean> {
        return isPersonalInfoPage(this.page.url(), this.eventUrl) && await this.expiredDialog().count() > 0;
    }

    async recover(returnQueueRecovery?: FlowRecovery): Promise<void> {
        if (!isPersonalInfoPage(this.page.url(), this.eventUrl) || await this.expiredDialog().count() !== 1 ||
            await this.page.locator(".klk-modal-alert").filter({ visible: true }).count() !== 1) {
            throw new Error("無法確認唯一的個人資料逾期彈窗，已停止恢復。");
        }
        const confirm = this.expiredDialog().getByRole("button", { name: "確認", exact: true });
        if (await confirm.count() !== 1 || !await confirm.isVisible() || !await confirm.isEnabled()) {
            throw new Error("個人資料逾期彈窗的確認按鈕不唯一或無法操作。");
        }
        log("個人資料預留已過期：按一次彈窗確認，等待原活動頁恢復。");
        await confirm.click({ timeout: this.timeout });
        await waitForRecoveryReturn(this.page, this.eventUrl, this.timeout,
            "確認逾期後未能恢復原活動選票區，已停止；不再次點擊或重整。", returnQueueRecovery);
        log("已返回原活動頁，重新選票與配位；不沿用舊預留資料。");
    }
}
