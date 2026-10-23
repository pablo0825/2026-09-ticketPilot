import type { KlookActivitySettings } from "../../../../config/activityStore.js";
import type { PurchaseSummaryData } from "../../pages/purchaseSummary.js";

function activityFields(eventName: string, eventUrl: string, canLink: boolean): PurchaseSummaryData["fields"] {
    return [
        { label: "活動名稱", value: eventName },
        { label: "活動網址", value: eventUrl, ...(canLink ? { href: eventUrl } : {}) },
    ];
}

function safeKlookLink(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname === "www.klook.com" &&
            /^\/zh-TW\/event-detail\/[^/]+\/$/.test(url.pathname) &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
}

// 摘要只讀已儲存設定；啟動仍使用 Workspace 核對的原始設定，不從這份顯示資料反推。
export function klookSummary(settings: KlookActivitySettings | undefined): PurchaseSummaryData | undefined {
    if (!settings) return undefined;
    const fields = activityFields(settings.eventName, settings.eventUrl, safeKlookLink(settings.eventUrl));
    fields.push({ label: "排隊流程", value: settings.queueEnabled ? "已啟用（最多等待一小時）" : "未啟用" });
    if (settings.bundleEnabled) fields.push({ label: "組合套票", value: "已啟用" });
    if (settings.deliveryMethod) fields.push({ label: "取票方式", value: settings.deliveryMethod });
    return {
        fields,
        columns: [
            { label: "順位" },
            { label: "演出日期" },
            { label: "時間" },
            { label: "票區／票種", wrap: true },
            { label: "張數" },
            { label: "要求連位" },
            ...(settings.bundleEnabled ? [{ label: "組合套票", wrap: true }] : []),
        ],
        rows: settings.targets.map((target, index) => [
            index + 1,
            target.date,
            target.time,
            target.area,
            target.quantity,
            target.quantity === 1 ? "不適用（單張）" : target.adjacent ? "是" : "否",
            ...(settings.bundleEnabled ? [target.bundle?.trim() || "未填寫"] : []),
        ]),
        notes: [
            { label: "購買規則", value: "依順位嘗試，只購買其中一個符合條件的目標" },
            { label: "排除關鍵字", value: settings.excludeKeywords.join("、") || "無" },
        ],
    };
}
