import type { TicketPlusDom } from "./domSnapshot.js";
import { single, unknownPage, validDate, validTime } from "./readResult.js";
import type { UnknownPage } from "./readResult.js";

export interface ActivityPage {
    kind: "activity";
    eventId: string;
    eventName: string;
    sessions: { name: string; date: string; time: string; buyEnabled: boolean }[];
}

export function parseActivityPage(dom: TicketPlusDom, eventId: string): ActivityPage | UnknownPage {
    // 活動名稱只接受唯一可見標題，場次列表不得空白。
    if (dom.activityNames.length > 1) return unknownPage("ambiguous-data");
    const eventName = single(dom.activityNames);
    if (!eventName || dom.activity.length === 0) return unknownPage("incomplete-data");

    // 逐列保存場次與該列按鈕；不推測按鈕沒有提供的場次 ID。
    const sessions: ActivityPage["sessions"] = [];
    for (const row of dom.activity) {
        if ([row.names, row.dates, row.times, row.buyButtons].some(values => values.length > 1)) {
            return unknownPage("ambiguous-data");
        }
        const name = single(row.names);
        const date = single(row.dates)?.replace(/\([一二三四五六日]\)$/, "");
        const time = single(row.times);
        const buyEnabled = single(row.buyButtons);
        if (!name || !date || !time || buyEnabled === undefined || !validDate(date) || !validTime(time)) {
            return unknownPage("incomplete-data");
        }
        sessions.push({ name, date, time, buyEnabled });
    }
    return { kind: "activity", eventId, eventName, sessions };
}
