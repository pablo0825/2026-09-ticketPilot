import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";

// 僅處理已觀察到的排隊逾時；不處理座位預留失敗或其他 OK 彈窗。
const expiredMessage = /^抱歉，時間到了！\s*請返回並重新排隊$/;

const selectors = {
    alert: ".klk-modal-alert",
    seatPanel: ".main_right-ZMnX67",
    tickets: "#ticket-options",
    option: ".spec-LwNjSh",
};

export class KlookQueueRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private isEventPage(): boolean {
        const expected = new URL(this.eventUrl);
        const current = new URL(this.page.url());
        return current.origin === expected.origin && current.pathname === expected.pathname;
    }

    private expiredQueueDialog(): Locator {
        return this.page.locator(selectors.alert).filter({
            has: this.page.getByText(expiredMessage), visible: true,
        });
    }

    async isRequired(): Promise<boolean> {
        // 已進入填寫資料或其他頁面時，不允許重啟購票。
        return this.isEventPage() && await this.expiredQueueDialog().count() > 0;
    }

    async recover(): Promise<void> {
        if (!this.isEventPage() || await this.expiredQueueDialog().count() !== 1) {
            throw new Error("無法確認唯一的排隊逾時彈窗，已停止恢復。");
        }
        const ok = this.expiredQueueDialog().getByRole("button", { name: "OK", exact: true });
        if (await ok.count() !== 1) throw new Error("排隊逾時彈窗的 OK 按鈕不唯一。");
        log("排隊逾時：按一次 OK，等待原活動頁恢復。");
        await ok.click({ timeout: this.timeout });
        await this.waitForEventPage();
        log("原活動頁已恢復，重新核對並設定票券；不沿用舊座位。");
    }

    private async waitForEventPage(): Promise<void> {
        const deadline = Date.now() + this.timeout;
        while (Date.now() < deadline) {
            if (await this.isEventPageReady()) return;
            await this.page.waitForTimeout(200);
        }
        throw new Error("按 OK 後未能確認活動頁恢復，已停止；不再次點擊或重整。");
    }

    private async isEventPageReady(): Promise<boolean> {
        if (!this.isEventPage()) return false;
        if (await this.page.locator(selectors.alert).filter({ visible: true }).count() > 0) return false;
        if (await this.page.locator(selectors.seatPanel).filter({ visible: true }).count() > 0) return false;

        // 這裡只確認選票入口恢復；完整日期、時間、票區仍由選票模組核對。
        const tickets = this.page.locator(selectors.tickets);
        if (!await tickets.isVisible()) return false;
        const options = tickets.locator(selectors.option);
        if (await options.count() === 0 || !await options.first().isVisible()) return false;

        const refresh = tickets.getByRole("button", { name: "重新整理", exact: true });
        return await refresh.count() === 1 && await refresh.isVisible() && await refresh.isEnabled();
    }

}
