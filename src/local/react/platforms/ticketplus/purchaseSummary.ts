import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";
import type { PurchaseSummaryData } from "../../pages/purchaseSummary.js";

function activityFields(eventName: string, eventUrl: string, canLink: boolean): PurchaseSummaryData["fields"] {
    return [
        { label: "活動名稱", value: eventName },
        { label: "活動網址", value: eventUrl, ...(canLink ? { href: eventUrl } : {}) },
    ];
}

export function ticketPlusSummary(settings: TicketPlusActivitySettings | undefined): PurchaseSummaryData | undefined {
    if (!settings) return undefined;
    return {
        fields: activityFields(settings.eventName, settings.eventUrl, true),
        columns: [
            { label: "順位" },
            { label: "演出日期" },
            { label: "時間" },
            { label: "票種", wrap: true },
            { label: "張數" },
        ],
        rows: settings.targets.map((target, index) => [
            index + 1,
            target.date,
            target.time,
            target.ticketType,
            target.quantity,
        ]),
        notes: [],
    };
}
