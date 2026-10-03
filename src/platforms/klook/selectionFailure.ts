import { SelectionExpiryNotice, getSelectionNotices, hasQueueExpiryNotice, hasSeatExpiryNotice, seatPanelSelector, seatShellSelector } from "./notices.js";
import type { Locator, Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { isEventPageReady, isEventPage } from "./eventPage.js";

type FailureReason = "sold-out" | "assignment-failed";

// 僅在本次下一步後辨識到完整指定提示時，由協調層轉成 unavailable。
export class SelectionFailure extends PurchaseStop {
    constructor(readonly reason: FailureReason) {
        super(`本次配位失敗：${reason}`);
    }
}

// 沿用已觀察的 Klook alert 容器。新失敗文案的結構仍未經實站重現。
export class KlookSelectionFailure {
    private pending: FailureReason | undefined;

    constructor(private readonly page: Page, private readonly eventUrl: string,
        private readonly timeout = 30_000) {}

    private async readFailure(): Promise<{ dialog: Locator; reason: FailureReason } | null> {
        if (!isEventPage(this.page.url(), this.eventUrl)) return null;
        const notices = await getSelectionNotices(this.page);
        if (notices.length !== 1) return null;
        const dialog = notices[0]!;
        if (!await dialog.evaluate(el => el.matches(".klk-modal-alert"))) return null;
        if (await this.page.locator(seatPanelSelector).locator(".list_item-jYRAN7").filter({ visible: true }).count() > 0) return null;
        const text = (await dialog.innerText()).replace(/\s/g, "");
        // 比對整個可見提示（含唯一按鈕文案），不接受任意包含「失敗」的文字。
        if (/^已經沒有票了[。！!]?(?:OK|確認|確定)$/.test(text)) return { dialog, reason: "sold-out" };
        if (/^選位失敗[，,]請重試[。！!]?(?:OK|確認|確定)$/.test(text)) return { dialog, reason: "assignment-failed" };
        return null;
    }

    async assertNoExistingNotice(): Promise<void> {
        const notices = await getSelectionNotices(this.page);
        if (notices.length === 1 &&
            ((isEventPage(this.page.url(), this.eventUrl) && await hasQueueExpiryNotice(this.page)) ||
                (isEventPage(this.page.url(), this.eventUrl) && await hasSeatExpiryNotice(this.page)))) {
            throw new SelectionExpiryNotice("選票前出現已知過期提示，交由既有恢復核對。");
        }
        if (!isEventPage(this.page.url(), this.eventUrl) || notices.length > 0) {
            throw new PurchaseStop("選票前已有提示或已離開活動頁，停止；不將舊提示視為本次失敗。");
        }
    }

    async observe(): Promise<void> {
        const failure = await this.readFailure();
        if (!failure) return;
        this.pending = failure.reason;
        throw new SelectionFailure(failure.reason);
    }

    async returnAfterFailure(): Promise<void> {
        const expected = this.pending;
        this.pending = undefined; // 行動前消耗本次關閉機會；失敗也不可再次點擊。
        if (!expected) throw new PurchaseStop("沒有本次已辨識的選位失敗，不操作彈窗。");
        const failure = await this.readFailure();
        if (!failure || failure.reason !== expected) throw new PurchaseStop("失敗提示已變動或不唯一，停止返回。");
        const buttons = failure.dialog.getByRole("button").filter({ visible: true });
        if (await buttons.count() !== 1) throw new PurchaseStop("失敗彈窗按鈕不唯一，停止返回。");
        const button = buttons.first();
        if (!/^(OK|確認|確定)$/.test((await button.innerText()).trim()) || !await button.isEnabled()) {
            throw new PurchaseStop("失敗彈窗按鈕無法核對，停止返回。");
        }
        await button.click({ timeout: this.timeout });
        const deadline = Date.now() + this.timeout;
        while (Date.now() < deadline) {
            // 不接續排隊恢復，也不自行 reload；只等網站完成返回。
            if (isEventPage(this.page.url(), this.eventUrl) && (await getSelectionNotices(this.page)).length === 0 &&
                await this.page.locator(seatShellSelector).filter({ visible: true }).count() === 0 &&
                await isEventPageReady(this.page, this.eventUrl)) return;
            await this.page.waitForTimeout(100);
        }
        throw new PurchaseStop("失敗提示關閉後未能確認選票入口恢復。");
    }
}
