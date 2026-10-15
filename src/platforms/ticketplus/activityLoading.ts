import type { TicketPlusDom } from "./domSnapshot.js";
import { single, validDate, validTime } from "./readResult.js";

export type ActivityLoading = "none" | "empty" | "loading-placeholder";

export interface ActivityLoadingTarget {
    eventId: string;
    eventName: string;
}

function hasOnlyActivityContent(dom: TicketPlusDom): boolean {
    return (
        dom.tickets.length === 0 &&
        dom.queueCount === 0 &&
        dom.dialogs.length === 0 &&
        dom.information.headingCount === 0 &&
        dom.information.terms.length === 0 &&
        dom.information.contact.every(fields => fields.length === 0) &&
        dom.nextButtons.length === 0 &&
        dom.paymentButtons.length === 0 &&
        dom.checkoutStepCount === 0 &&
        dom.checkout.length === 0
    );
}

export function inspectActivityLoading(dom: TicketPlusDom, target: ActivityLoadingTarget): ActivityLoading {
    // 只在同活動且沒有其他流程內容時辨識載入，不能遮蔽錯誤身分或彈窗。
    const route = /^\/activity\/([A-Za-z0-9_-]+)\/?$/.exec(dom.pathname);
    if (
        dom.origin !== "https://ticketplus.com.tw" ||
        dom.extraUrlParts ||
        route?.[1] !== target.eventId ||
        !hasOnlyActivityContent(dom)
    ) {
        return "none";
    }

    // 空白頁維持原條件；有列時只接受單一已觀測佔位，不合併重複內容。
    const heading = single(dom.activityNames);
    if (dom.activity.length === 0) {
        return dom.activityNames.length === 0 || heading === target.eventName ? "empty" : "none";
    }
    if (dom.activityNames.length > 1 || (heading !== undefined && heading !== "" && heading !== target.eventName)) {
        return "none";
    }
    const row = single(dom.activity);
    if (
        !row ||
        single(row.names) !== "Loading..." ||
        row.dates.length !== 2 ||
        row.times.length !== 0 ||
        single(row.saleButtons)?.text !== "立即購買"
    ) {
        return "none";
    }

    // 佔位日期與時間須為合法範圍；不依固定年份或缺時間的計數猜測。
    const dates = row.dates.map(value => value.replace(/\([一二三四五六日]\)$/, ""));
    if (!dates.every(validDate) || dates[0]! >= dates[1]!) return "none";
    const range = single(row.timeRanges)?.split(/\s*~\s*/);
    if (!range || range.length !== 2 || !range.every(validTime) || range[0]! >= range[1]!) return "none";
    return "loading-placeholder";
}
