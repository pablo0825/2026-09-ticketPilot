import type { Locator, Page } from "playwright";
import { isEventPage, seatPanelSelector, seatShellSelector } from "./eventPage.js";

// 僅標記已辨識的選票過期提示；恢復資格與額度仍由恢復流程核對。
export class SelectionExpiryNotice extends Error {}

// Klook 提示的共用只讀規則；是否恢復、按哪個按鈕由各流程決定。
export const queueExpiredMessage = /^抱歉，時間到了！\s*請返回並重新排隊$/;
// 完整文案供恢復辨識；部分文案只用來先停止操作，不能單憑它啟動恢復。
export const reservationExpiredMessage = /^未於時限內確認[，,]\s*票券預留失敗$/;
export const reservationExpiredNotice = /未於時限內確認[，,]\s*票券預留失敗/;

// 配位觀察要求整個提示只有指定文字和 OK；不放寬成包含文字即可。
export function isExpiryNotice(text: string, kind: "queue" | "reservation"): boolean {
    const message = kind === "queue" ? queueExpiredMessage : reservationExpiredMessage;
    return text.endsWith("OK") && message.test(text.slice(0, -2).trim());
}

export function expiredDialog(page: Page, message: RegExp): Locator {
    return page.locator(".klk-modal-alert").filter({ has: page.getByText(message), visible: true });
}

// 每次辨識都先核對目前網址；恢復流程另行檢查唯一彈窗、按鈕與額度。
export async function isQueueExpiryShown(page: Page, eventUrl: string): Promise<boolean> {
    return isEventPage(page.url(), eventUrl) && (await expiredDialog(page, queueExpiredMessage).count()) > 0;
}

export async function isSeatExpiryShown(page: Page, eventUrl: string): Promise<boolean> {
    return (
        isEventPage(page.url(), eventUrl) &&
        (await page.locator(seatPanelSelector).filter({ visible: true }).count()) === 1 &&
        (await expiredDialog(page, reservationExpiredMessage).count()) > 0
    );
}

export async function getSelectionNotices(page: Page): Promise<Locator[]> {
    const result: Locator[] = [];
    for (const notice of await page
        .locator('.klk-modal-alert, [role="dialog"], dialog')
        .filter({ visible: true })
        .all()) {
        if (await notice.evaluate((el, selector) => el.matches(selector), `${seatShellSelector}, ${seatPanelSelector}`))
            continue;
        if (await notice.locator(seatPanelSelector).count()) continue;
        result.push(notice);
    }
    return result;
}
