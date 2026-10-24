import { z } from "zod";

export class ArchivedKlookActivityError extends Error {
    constructor() {
        super("已不支援 Klook 活動；原始資料保留，請使用 archive/klook 分支管理。");
    }
}

// 只辨識封存檔案的結構；不恢復 Klook 購票設定或執行規則。
const archivedSettings = z
    .object({
        eventUrl: z.string().regex(/^https:\/\/www\.klook\.com\/zh-TW\/event-detail\/[^/?#]+\/(?:[?#].*)?$/),
        eventName: z.string().trim().min(1),
        currency: z.unknown().optional(),
        fallbackMode: z.literal("STRICT"),
        excludeKeywords: z.array(z.string().trim().min(1)),
        targets: z
            .array(
                z
                    .object({
                        date: z.string(),
                        time: z.string(),
                        area: z.string().trim().min(1),
                        unitPrice: z.unknown().optional(),
                        quantity: z.number().int().positive().safe(),
                        adjacent: z.boolean(),
                        bundle: z.string().trim().optional(),
                    })
                    .strict(),
            )
            .min(1),
        saleSchedule: z
            .object({
                saleAt: z.string(),
                advanceSeconds: z.union([z.literal(1), z.literal(2)]).optional(),
            })
            .strict()
            .optional(),
        queueEnabled: z.boolean().optional(),
        bundleEnabled: z.boolean().optional(),
        deliveryMethod: z.string().trim().min(1).optional(),
    })
    .strict();
const archivedPlatformSettings = archivedSettings.extend({ platform: z.literal("klook") });

export function isArchivedKlookActivity(schemaVersion: number, settings: unknown): boolean {
    if (schemaVersion === 1) return archivedSettings.safeParse(settings).success;
    if (schemaVersion === 3) return archivedPlatformSettings.safeParse(settings).success;
    return false;
}
