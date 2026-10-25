import { parseTicketPlusActivity } from "./platforms/ticketplus/activitySettings.js";

export interface SettingsParser<S extends { platform: string }> {
    id: S["platform"];
    parse(value: unknown): S;
}

// 正式入口與測試平台使用同一分派規則；平台不符不能退回預設解析器。
export function createSettingsParser<S extends { platform: string }>(entries: readonly SettingsParser<S>[]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("平台設定重複登記。");

    return (value: unknown): S => {
        if (!value || typeof value !== "object") throw new Error("活動平台無效。");

        if (!("platform" in value)) throw new Error("活動平台無效。");

        const entry = entries.find(item => item.id === value.platform);
        if (!entry) throw new Error("不支援的活動平台。");

        const settings = entry.parse(value);
        if (settings.platform !== entry.id) throw new Error("活動設定與平台不符。");

        return settings;
    };
}

export const platformIds = ["ticketplus"] as const;
export type Platform = (typeof platformIds)[number];
export const parsePlatformSettings = createSettingsParser([{ id: "ticketplus", parse: parseTicketPlusActivity }]);
