import { z } from "zod";
import { validateSaleSchedule } from "../core/purchaseValidation.js";

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
const scheduleSchema = z
    .object({
        saleAt: z.string(),
        advanceSeconds: z.union([z.literal(1), z.literal(2)]),
    })
    .strict();
const activitySchema = z
    .object({
        ...activityIdentity,
        targets: z.array(targetSchema).min(1),
        saleSchedule: scheduleSchema.optional(),
    })
    .strict();
const invalidSettings =
    "TicketPlus 活動設定格式錯誤，請檢查活動網址、名稱、日期、時間、票種、張數，以及開賣時間與提前秒數。";

export type TicketPlusActivitySettings = z.infer<typeof activitySchema>;
export type TicketPlusSelection = z.infer<typeof selectionSchema>;
export class TicketPlusCapabilityError extends Error {}

export function parseTicketPlusActivity(value: unknown): TicketPlusActivitySettings {
    const result = activitySchema.safeParse(value);
    if (!result.success) throw new Error(invalidSettings);
    if (result.data.saleSchedule) validateSaleSchedule(result.data.saleSchedule);
    return result.data;
}

// DOM 模組只接受明確的單次目標，不能自行取多順位清單的第一筆。
export function parseTicketPlusSelection(value: unknown): TicketPlusSelection {
    const result = selectionSchema.safeParse(value);
    if (!result.success) throw new Error(invalidSettings);
    return result.data;
}

// 舊執行紀錄的單目標投影；不得丟棄多順位或排程以比對歷史指紋。
export function singleTicketPlusSelection(settings: TicketPlusActivitySettings): TicketPlusSelection {
    if (settings.saleSchedule) {
        throw new TicketPlusCapabilityError("TicketPlus 開賣等待與提前刷新尚未接通；設定可保存，但本次不會啟動購票。");
    }
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

// 執行能力與舊紀錄的單目標投影分開；只有同一場次可依序選票。
export function ticketPlusSessionSelection(settings: TicketPlusActivitySettings): TicketPlusSelection {
    if (settings.saleSchedule) {
        throw new TicketPlusCapabilityError("TicketPlus 開賣等待與提前刷新尚未接通；設定可保存，但本次不會啟動購票。");
    }
    const first = settings.targets[0]!;
    if (settings.targets.some(target => target.date !== first.date || target.time !== first.time)) {
        throw new TicketPlusCapabilityError("TicketPlus 目前只支援同場次多順位；不同日期或時間不會啟動購票。");
    }
    return { platform: settings.platform, eventUrl: settings.eventUrl, eventName: settings.eventName, target: first };
}
