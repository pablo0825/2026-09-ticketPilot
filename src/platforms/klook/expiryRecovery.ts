import type { Locator, Page } from "playwright";
import type { FlowRecovery } from "../../core/recovery.js";
import { log } from "../../core/logger.js";
import { isEventPage, isEventPageReady } from "./eventPage.js";
import { isPersonalInfoPage } from "./personalInfoPage.js";
import { expiredDialog, isQueueExpiryShown, isSeatExpiryShown, queueExpiredMessage, reservationExpiredMessage } from "./notices.js";

// 共用彈窗與按鈕檢查；各類別仍先核對自己的頁面與觸發條件。
async function requireRecoveryButton(page: Page, dialog: Locator, buttonName: string,
    dialogError: string, buttonError: string): Promise<Locator> {
    if (await dialog.count() !== 1 || await page.locator(".klk-modal-alert").filter({ visible: true }).count() !== 1) {
        throw new Error(dialogError);
    }
    const button = dialog.getByRole("button", { name: buttonName, exact: true });
    if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) {
        throw new Error(buttonError);
    }
    return button;
}

// 每次呼叫只點一次；整次執行的額度由 core 在呼叫恢復前消耗。
async function clickAndWaitForReturn(button: Locator, page: Page, eventUrl: string,
    timeout: number, failureMessage: string, returnQueueRecovery?: FlowRecovery): Promise<void> {
    await button.click({ timeout });
    await waitForRecoveryReturn(page, eventUrl, timeout, failureMessage, returnQueueRecovery);
}

// 僅處理已觀察到的排隊逾時；不處理座位預留失敗或其他 OK 彈窗。
export class KlookQueueRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private expiredQueueDialog(): Locator {
        return expiredDialog(this.page, queueExpiredMessage);
    }

    async isRequired(): Promise<boolean> {
        // 已進入填寫資料或其他頁面時，不允許重啟購票。
        return isQueueExpiryShown(this.page, this.eventUrl);
    }

    async recover(): Promise<void> {
        if (!isEventPage(this.page.url(), this.eventUrl)) throw new Error("無法確認唯一的排隊逾時彈窗，已停止恢復。");
        const button = await requireRecoveryButton(this.page, this.expiredQueueDialog(), "OK",
            "無法確認唯一的排隊逾時彈窗，已停止恢復。", "排隊逾時彈窗的 OK 按鈕不唯一或無法操作。");
        log("排隊逾時：按一次 OK，等待原活動頁恢復。");
        await clickAndWaitForReturn(button, this.page, this.eventUrl, this.timeout,
            "按 OK 後未能確認活動頁恢復，已停止；不再次點擊或重整。");
        log("原活動頁已恢復，重新核對並設定票券；不沿用舊座位。");
    }
}

// 由流程協調層限定於尚未嘗試座位確認的階段。
export class KlookSeatRecovery implements FlowRecovery {
    constructor(private readonly page: Page, private readonly eventUrl: string, private readonly timeout = 30_000) {}

    private expiredDialog(): Locator {
        return expiredDialog(this.page, reservationExpiredMessage);
    }

    async isRequired(): Promise<boolean> {
        return isSeatExpiryShown(this.page, this.eventUrl);
    }

    async recover(returnQueueRecovery?: FlowRecovery): Promise<void> {
        if (!await this.isRequired()) throw new Error("無法確認唯一的選位逾期彈窗，已停止恢復。");
        const button = await requireRecoveryButton(this.page, this.expiredDialog(), "OK",
            "無法確認唯一的選位逾期彈窗，已停止恢復。", "選位逾期彈窗的 OK 按鈕不唯一或無法操作。");
        log("選位預留已過期：按一次 OK，等待原活動選票區恢復。");
        await clickAndWaitForReturn(button, this.page, this.eventUrl, this.timeout,
            "選位逾期按 OK 後未能恢復選票入口，已停止；不再次點擊或重整。", returnQueueRecovery);
        log("選票入口已恢復，重新核對選票條件並取得新座位。");
    }
}

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
        if (!isPersonalInfoPage(this.page.url(), this.eventUrl)) throw new Error("無法確認唯一的個人資料逾期彈窗，已停止恢復。");
        const button = await requireRecoveryButton(this.page, this.expiredDialog(), "確認",
            "無法確認唯一的個人資料逾期彈窗，已停止恢復。", "個人資料逾期彈窗的確認按鈕不唯一或無法操作。");
        log("個人資料預留已過期：按一次彈窗確認，等待原活動頁恢復。");
        await clickAndWaitForReturn(button, this.page, this.eventUrl, this.timeout,
            "確認逾期後未能恢復原活動選票區，已停止；不再次點擊或重整。", returnQueueRecovery);
        log("已返回原活動頁，重新選票與配位；不沿用舊預留資料。");
    }
}

// 返回階段最多等 timeout；接續排隊後由排隊模組自己的固定期限等待就緒。
// 排隊恢復不傳入接續處理器，因此不會遞迴或再次按 OK。
async function waitForRecoveryReturn(page: Page, eventUrl: string, timeout: number,
    failureMessage: string, returnQueueRecovery?: FlowRecovery): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (await isEventPageReady(page, eventUrl)) return;
        if (returnQueueRecovery && await returnQueueRecovery.isRequired()) {
            log("本次恢復途中出現排隊逾期：接續處理一次，仍屬同一次購票恢復。");
            await returnQueueRecovery.recover();
            if (!await isEventPageReady(page, eventUrl)) throw new Error(failureMessage);
            return;
        }
        await page.waitForTimeout(200);
    }
    throw new Error(failureMessage);
}
