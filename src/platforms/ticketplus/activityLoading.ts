import type { TicketPlusDom } from "./domSnapshot.js";
import { isSessionButtonText, normalizeSessionName } from "./activityPage.js";
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

type ActivityRow = TicketPlusDom["activity"][number];

function isReadableSessionRow(row: ActivityRow): boolean {
    // 名稱須唯一且不像 Loading... 佔位；大小寫或省略號不同也視為載入中。
    const name = single(row.names);
    if (name === undefined || !normalizeSessionName(name) || /^loading/i.test(normalizeSessionName(name))) {
        return false;
    }

    // 日期為單日或遞增兩日區間；時間為單一時間或時間區間，欄位與值容器各一個。
    const counts = [row.dateField.labels, row.dateField.values, row.timeField.labels, row.timeField.values];
    if (counts.some(count => count !== 1)) return false;
    const dates = row.dates.map(value => value.replace(/\([一二三四五六日]\)$/, ""));
    if (dates.length < 1 || dates.length > 2 || !dates.every(validDate)) return false;
    if (dates.length === 2 && dates[0]! >= dates[1]!) return false;
    const times = [...row.times, ...row.timeRanges.flatMap(range => range.split(/\s*~\s*/))];
    if (row.times.length + row.timeRanges.length !== 1 || !times.every(validTime)) return false;

    // 佔位列同時有日期區間與時間區間；同形狀的列不論名稱都保守視為載入中。
    if (dates.length === 2 && row.timeRanges.length === 1) return false;

    // 按鈕區仍顯示 progressbar 時沒有按鈕，視為尚未載入完成。
    const button = single(row.saleButtons);
    return button !== undefined && isSessionButtonText(button.text);
}

// 至少一列且每列都可完整讀取時，才視為場次列表已載入；空白、佔位或缺欄位仍在載入。
export function isActivityFullyLoaded(dom: TicketPlusDom): boolean {
    return dom.activity.length > 0 && dom.activity.every(isReadableSessionRow);
}
