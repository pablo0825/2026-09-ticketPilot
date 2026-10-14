import { z } from "zod";

function isCalendarDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// 第一版只描述單一場次與票種；尚未接入活動儲存或購票入口。
const ticketPlusActivitySchema = z
    .object({
        platform: z.literal("ticketplus"),
        // 僅接受活動入口，允許結尾斜線；不接受帳密、連接埠、查詢參數或片段。
        eventUrl: z
            .string()
            .url()
            .regex(/^https:\/\/ticketplus\.com\.tw\/activity\/[A-Za-z0-9_-]+\/?$/),
        eventName: z.string().trim().min(1),
        target: z
            .object({
                date: z.string().refine(isCalendarDate),
                time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
                ticketType: z.string().trim().min(1),
                quantity: z.number().int().positive().safe(),
            })
            .strict(),
    })
    .strict();

export type TicketPlusActivitySettings = z.infer<typeof ticketPlusActivitySchema>;

export function parseTicketPlusActivity(value: unknown): TicketPlusActivitySettings {
    const result = ticketPlusActivitySchema.safeParse(value);
    if (!result.success) throw new Error("TicketPlus 活動設定格式錯誤，請檢查活動網址、名稱、日期、時間、票種與張數。");
    return result.data;
}
