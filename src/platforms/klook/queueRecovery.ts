import { expiredDialog, queueExpiredMessage } from "./notices.js";
import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { isEventPage } from "./eventPage.js";
import { waitForRecoveryReturn } from "./recoveryReturn.js";
import { log } from "../../core/logger.js";

// 僅處理已觀察到的排隊逾時；不處理座位預留失敗或其他 OK 彈窗。
export class KlookQueueRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private expiredQueueDialog(): Locator {
        return expiredDialog(this.page, queueExpiredMessage);
    }

    async isRequired(): Promise<boolean> {
        // 已進入填寫資料或其他頁面時，不允許重啟購票。
        return isEventPage(this.page.url(), this.eventUrl) && await this.expiredQueueDialog().count() > 0;
    }

    async recover(): Promise<void> {
        if (!isEventPage(this.page.url(), this.eventUrl) || await this.expiredQueueDialog().count() !== 1 ||
            await this.page.locator(".klk-modal-alert").filter({ visible: true }).count() !== 1) {
            throw new Error("無法確認唯一的排隊逾時彈窗，已停止恢復。");
        }
        const ok = this.expiredQueueDialog().getByRole("button", { name: "OK", exact: true });
        if (await ok.count() !== 1 || !await ok.isVisible() || !await ok.isEnabled()) throw new Error("排隊逾時彈窗的 OK 按鈕不唯一或無法操作。");
        log("排隊逾時：按一次 OK，等待原活動頁恢復。");
        await ok.click({ timeout: this.timeout });
        await waitForRecoveryReturn(this.page, this.eventUrl, this.timeout,
            "按 OK 後未能確認活動頁恢復，已停止；不再次點擊或重整。");
        log("原活動頁已恢復，重新核對並設定票券；不沿用舊座位。");
    }

}
