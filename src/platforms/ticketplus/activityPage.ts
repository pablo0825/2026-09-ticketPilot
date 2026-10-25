import type { TicketPlusDom } from "./domSnapshot.js";
import { single, unknownPage, validDate, validTime } from "./readResult.js";
import type { UnknownPage } from "./readResult.js";

export interface ActivityPage {
    kind: "activity";
    eventId: string;
    eventName: string;
    sessions: {
        name: string;
        date: string;
        time: string;
        buyEnabled: boolean;
        saleState: "available" | "not-on-sale" | "disabled";
        // 購票為「立即購買」、抽選為「立即登記」；選場次時依流程類型核對。
        buttonText: SessionButtonText;
    }[];
}

export type SessionButtonText = "立即購買" | "立即登記" | "尚未開賣";
const sessionButtonTexts: readonly string[] = ["立即購買", "立即登記", "尚未開賣"];

export function isSessionButtonText(text: string): text is SessionButtonText {
    return sessionButtonTexts.includes(text);
}

export function normalizeSessionName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
}

export function parseActivityPage(
    dom: TicketPlusDom,
    eventId: string,
    targetName?: string,
): ActivityPage | UnknownPage {
    // 指定目標時只解析同名場次，其他列的時間範圍不影響目標。
    const rows =
        targetName === undefined
            ? dom.activity
            : dom.activity.filter(row =>
                  row.names.some(name => normalizeSessionName(name) === normalizeSessionName(targetName)),
              );
    if (targetName !== undefined && rows.length > 1) return unknownPage("ambiguous-data");
    if (targetName === undefined && dom.activityNames.length > 1) return unknownPage("ambiguous-data");

    const eventName = targetName ?? single(dom.activityNames);
    if (!eventName || rows.length === 0) return unknownPage("incomplete-data");

    // 逐列保存場次與該列按鈕；不推測按鈕沒有提供的場次 ID。
    const sessions: ActivityPage["sessions"] = [];
    for (const row of rows) {
        if ([row.names, row.dates, row.times, row.saleButtons].some(values => values.length > 1)) {
            return unknownPage("ambiguous-data");
        }

        // 欄位容器也必須唯一，不能漏掉重複但空白的值容器。
        const counts = [row.dateField.labels, row.dateField.values, row.timeField.labels, row.timeField.values];
        if (counts.some(count => count > 1)) return unknownPage("ambiguous-data");
        if (counts.some(count => count !== 1)) return unknownPage("incomplete-data");

        const name = single(row.names);
        const date = single(row.dates)?.replace(/\([一二三四五六日]\)$/, "");
        const time = single(row.times);
        const button = single(row.saleButtons);
        if (!name || !date || !time || !button) {
            return unknownPage("incomplete-data");
        }

        if (!validDate(date) || !validTime(time)) {
            return unknownPage("incomplete-data");
        }

        const buttonText = button.text;
        if (!isSessionButtonText(buttonText)) return unknownPage("incomplete-data");

        const saleState = buttonText === "尚未開賣" ? "not-on-sale" : button.enabled ? "available" : "disabled";
        sessions.push({ name, date, time, buyEnabled: saleState === "available", saleState, buttonText });
    }

    return { kind: "activity", eventId, eventName, sessions };
}

// 僅描述既有快照的欄位完整性，不回傳文字或參與流程判斷。
export function diagnoseActivityFields(dom: TicketPlusDom, expectedName: string) {
    // 標題保留數量與比對結果，區分缺少、空白及非目標標題。
    const headings = {
        count: dom.activityNames.length,
        nonEmptyCount: dom.activityNames.filter(name => Boolean(name)).length,
        matchingCount: dom.activityNames.filter(name => name === expectedName).length,
    };

    // 日期正規化與格式檢查沿用 parser，缺少或重複欄位不視為有效。
    const rows = dom.activity.map(row => {
        const date = single(row.dates)?.replace(/\([一二三四五六日]\)$/, "");
        const time = single(row.times);
        const button = single(row.saleButtons);
        return {
            names: row.names.length,
            nameNonEmpty: Boolean(single(row.names)),
            dateField: { ...row.dateField },
            timeField: { ...row.timeField },
            dates: row.dates.length,
            dateValid: date !== undefined && validDate(date),
            times: row.times.length,
            timeValid: time !== undefined && validTime(time),
            buttons: row.saleButtons.length,
            knownButtonText: button !== undefined && isSessionButtonText(button.text),
            buttonEnabled: button?.enabled ?? null,
        };
    });
    const matchingRows = dom.activity.filter(row =>
        row.names.some(name => normalizeSessionName(name) === normalizeSessionName(expectedName)),
    ).length;
    return { headings, rows, matchingRows };
}
