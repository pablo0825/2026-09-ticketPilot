import { z } from "zod";
import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PurchaseConfig } from "../core/types.js";
import { validatePurchaseConfig } from "../core/purchaseValidation.js";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const activitySchema = z.object({
    eventUrl: z.string().url().refine(value => {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "www.klook.com" &&
            /^\/zh-TW\/event-detail\/[^/]+\/$/.test(url.pathname) && !url.username && !url.password;
    }),
    eventName: z.string().trim().min(1),
    fallbackMode: z.literal("STRICT"),
    excludeKeywords: z.array(z.string().trim().min(1)),
    targets: z.array(z.object({
        date: z.string(), time: z.string(), area: z.string().trim().min(1),
        unitPrice: z.number().int().positive().safe(), quantity: z.number().int().positive().safe(),
        adjacent: z.boolean(),
    }).strict()).min(1),
    saleSchedule: z.object({ saleAt: z.string(), advanceSeconds: z.union([z.literal(1), z.literal(2)]).optional() }).strict().optional(),
}).strict();
export type ActivitySettings = z.infer<typeof activitySchema>;
export interface ActivityRecord {
    schemaVersion: 1;
    id: string;
    updatedAt: string;
    settings: ActivitySettings;
}

export function parseActivity(value: unknown): ActivitySettings {
    const result = activitySchema.safeParse(value);
    if (!result.success) throw new Error("活動設定格式錯誤，請檢查網址與必要欄位。");
    const settings = result.data;
    validatePurchaseConfig(toPurchaseConfig(settings));
    return settings;
}

// 僅適用目前支援的票價合計；頁面若有額外費用，仍由既有摘要核對拒絕。
export function toPurchaseConfig(settings: ActivitySettings): PurchaseConfig {
    return {
        eventUrl: settings.eventUrl,
        fallbackMode: settings.fallbackMode,
        excludeKeywords: [...settings.excludeKeywords],
        ...(settings.saleSchedule ? { saleSchedule: { ...settings.saleSchedule } } : {}),
        targets: settings.targets.map(({ unitPrice, ...target }) => ({
            ...target,
            expectation: { eventName: settings.eventName, unitPrice, totalPrice: unitPrice * target.quantity },
        })),
    };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value, null, 4) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
}

export class ActivityStore {
    constructor(private readonly directory = join(projectRoot, "local-data", "events")) {}

    private path(id: string): string {
        if (!z.string().uuid().safeParse(id).success) throw new Error("活動識別碼無效。");
        return join(this.directory, `${id}.json`);
    }

    async load(id: string): Promise<ActivityRecord> {
        let value: unknown;
        try { value = JSON.parse(await readFile(this.path(id), "utf8")); }
        catch { throw new Error("無法載入活動設定。"); }
        const record = z.object({ schemaVersion: z.literal(1), id: z.literal(id), updatedAt: z.string().datetime(), settings: z.unknown() }).strict().safeParse(value);
        if (!record.success) throw new Error("活動檔案版本或內容無效。");
        return { ...record.data, settings: parseActivity(record.data.settings) };
    }

    async save(value: unknown, id?: string): Promise<ActivityRecord> {
        const settings = parseActivity(value);
        if (id !== undefined) await this.load(id); // 修改不能偷偷建立另一個 ID。
        const record: ActivityRecord = { schemaVersion: 1, id: id ?? randomUUID(), updatedAt: new Date().toISOString(), settings };
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(this.path(record.id), record);
        return record;
    }

    async list(): Promise<{ activities: ActivityRecord[]; invalidFiles: number }> {
        const files = await readdir(this.directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        const activities: ActivityRecord[] = [];
        let invalidFiles = 0;
        for (const file of files.filter(file => file.endsWith(".json"))) {
            try { activities.push(await this.load(file.slice(0, -5))); }
            catch { invalidFiles++; }
        }
        return { activities: activities.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), invalidFiles };
    }
}
