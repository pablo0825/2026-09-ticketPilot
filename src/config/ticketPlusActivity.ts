import { z } from "zod";

function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 活動識別與單一目標的驗證共用；設定與單次 DOM 操作各有明確格式。
const activityIdentity = {
    platform: z.literal("ticketplus"),
    eventUrl: z
        .string()
        .url()
        .regex(/^https:\/\/ticketplus\.com\.tw\/activity\/[A-Za-z0-9_-]+\/?$/),
    eventName: z.string().trim().min(1),
};
const targetSchema = z
    .object({
        date: z.string().refine(isCalendarDate),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        ticketType: z.string().trim().min(1),
        quantity: z.number().int().positive().safe(),
    })
    .strict();
const selectionSchema = z.object({ ...activityIdentity, target: targetSchema }).strict();
const activitySchema = z.object({ ...activityIdentity, targets: z.array(targetSchema).min(1) }).strict();
const invalidSettings = "TicketPlus 活動設定格式錯誤，請檢查活動網址、名稱、日期、時間、票種與張數。";

export type TicketPlusActivitySettings = z.infer<typeof activitySchema>;
export type TicketPlusSelection = z.infer<typeof selectionSchema>;
export class TicketPlusCapabilityError extends Error {}

export function parseTicketPlusActivity(value: unknown): TicketPlusActivitySettings {
    const result = activitySchema.safeParse(value);
    if (!result.success) throw new Error(invalidSettings);
    return result.data;
}

// DOM 模組只接受明確的單次目標，不能自行取多順位清單的第一筆。
export function parseTicketPlusSelection(value: unknown): TicketPlusSelection {
    const result = selectionSchema.safeParse(value);
    if (!result.success) throw new Error(invalidSettings);
    return result.data;
}

// 多順位目前可保存；執行策略接通前必須在任何啟動副作用之前拒絕。
export function singleTicketPlusSelection(settings: TicketPlusActivitySettings): TicketPlusSelection {
    if (settings.targets.length !== 1) {
        throw new TicketPlusCapabilityError(
            "TicketPlus 多順位執行尚未接通；目前只能啟動單一順位，不會只執行第一順位。",
        );
    }
    return {
        platform: settings.platform,
        eventUrl: settings.eventUrl,
        eventName: settings.eventName,
        target: settings.targets[0]!,
    };
}
