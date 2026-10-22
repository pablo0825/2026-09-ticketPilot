import { z } from "zod";
import { parseTicketPlusActivity } from "./ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "./ticketPlusActivity.js";
import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PurchaseConfig } from "../core/types.js";
import { validatePurchaseConfig } from "../core/purchaseValidation.js";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const activityFields = z
    .object({
        eventUrl: z
            .string()
            .url()
            .refine(value => {
                const url = new URL(value);
                return (
                    url.protocol === "https:" &&
                    url.hostname === "www.klook.com" &&
                    /^\/zh-TW\/event-detail\/[^/]+\/$/.test(url.pathname) &&
                    !url.username &&
                    !url.password
                );
            }),
        eventName: z.string().trim().min(1),
        currency: z.unknown().optional(), // 相容舊活動，解析後移除。
        fallbackMode: z.literal("STRICT"),
        excludeKeywords: z.array(z.string().trim().min(1)),
        targets: z
            .array(
                z
                    .object({
                        date: z.string(),
                        time: z.string(),
                        area: z.string().trim().min(1),
                        unitPrice: z.unknown().optional(), // 相容舊活動，解析後移除。
                        quantity: z.number().int().positive().safe(),
                        adjacent: z.boolean(),
                        bundle: z.string().trim().optional(),
                    })
                    .strict()
                    .transform(({ unitPrice: _unitPrice, ...target }) => target),
            )
            .min(1),
        saleSchedule: z
            .object({ saleAt: z.string(), advanceSeconds: z.union([z.literal(1), z.literal(2)]).optional() })
            .strict()
            .optional(),
        queueEnabled: z.boolean().optional(),
        bundleEnabled: z.boolean().optional(),
        deliveryMethod: z.string().trim().min(1).optional(),
    })
    .strict();

// 保留既有欄位整理規則，舊活動價格只讀入、不繼續保存。
function normalizeActivity({ currency: _currency, ...settings }: z.infer<typeof activityFields>) {
    if (!settings.queueEnabled) delete settings.queueEnabled;
    if (!settings.bundleEnabled) {
        delete settings.bundleEnabled;
        for (const target of settings.targets) delete target.bundle;
    }
    return settings;
}

const activitySchema = z
    .object({ platform: z.literal("klook"), ...activityFields.shape })
    .strict()
    .transform(({ platform, ...settings }) => ({ platform, ...normalizeActivity(settings) }));

export type KlookActivitySettings = z.infer<typeof activitySchema>;
export type ActivitySettings = KlookActivitySettings | TicketPlusActivitySettings;

export interface ActivityRecord {
    schemaVersion: 1 | 3; // 來源檔案版本；settings 一律為已驗證的新格式。
    id: string;
    updatedAt: string;
    settings: ActivitySettings;
}

export type KlookActivityRecord = ActivityRecord & { settings: KlookActivitySettings };

export function requireKlookActivity(settings: ActivitySettings): asserts settings is KlookActivitySettings {
    if (settings.platform !== "klook") throw new Error("此設定轉換僅支援 Klook 活動。");
}

export function parseActivity(value: unknown): ActivitySettings {
    if (value && typeof value === "object" && "platform" in value && value.platform === "ticketplus") {
        return parseTicketPlusActivity(value);
    }
    if (value && typeof value === "object" && "platform" in value && value.platform !== "klook") {
        throw new Error("尚未支援此購票平台，目前只支援 Klook。");
    }
    const result = activitySchema.safeParse(value);
    if (!result.success) throw new Error("活動設定格式錯誤，請檢查網址與必要欄位。");

    const settings = result.data;
    validatePurchaseConfig(toPurchaseConfig(settings));
    return settings;
}

// 活動設定只轉換購票目標，金額由使用者在付款前確認。
export function toPurchaseConfig(settings: ActivitySettings): PurchaseConfig {
    requireKlookActivity(settings);
    return {
        eventUrl: settings.eventUrl,
        fallbackMode: settings.fallbackMode,
        excludeKeywords: [...settings.excludeKeywords],
        ...(settings.saleSchedule ? { saleSchedule: { ...settings.saleSchedule } } : {}),
        ...(settings.queueEnabled ? { queueEnabled: true } : {}),
        ...(settings.bundleEnabled ? { bundleEnabled: true } : {}),
        ...(settings.deliveryMethod ? { deliveryMethod: settings.deliveryMethod } : {}),
        targets: settings.targets.map(target => ({
            ...target,
            expectation: {
                eventName: settings.eventName,
            },
        })),
    };
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(value, null, 4) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, path);
    } finally {
        await unlink(temporary).catch(error => {
            if (error.code !== "ENOENT") throw error;
        });
    }
}

export class ActivityStore {
    constructor(private readonly directory = join(projectRoot, "local-data", "events")) {}

    private path(id: string): string {
        if (!z.string().uuid().safeParse(id).success) throw new Error("活動識別碼無效。");
        return join(this.directory, `${id}.json`);
    }

    async load(id: string): Promise<ActivityRecord> {
        // 讀取並解析活動檔案
        let value: unknown;
        try {
            value = JSON.parse(await readFile(this.path(id), "utf8"));
        } catch {
            throw new Error("無法載入活動設定。");
        }

        // 確認檔案版本與 ID 相符
        const record = z
            .object({
                schemaVersion: z.union([z.literal(1), z.literal(3)]),
                id: z.literal(id),
                updatedAt: z.string().datetime(),
                settings: z.unknown(),
            })
            .strict()
            .safeParse(value);
        if (!record.success) throw new Error("活動檔案版本或內容無效。");

        // 只有版本一讀檔可以補平台；先用原規則拒絕未知欄位
        let settings = record.data.settings;
        if (record.data.schemaVersion === 1) {
            const legacy = activityFields.safeParse(settings);
            if (!legacy.success) throw new Error("舊活動設定格式錯誤。");
            settings = { platform: "klook", ...legacy.data };
        }
        return { ...record.data, settings: parseActivity(settings) };
    }

    async save(value: unknown, id?: string): Promise<ActivityRecord> {
        // 檢查設定；修改時確認原活動存在
        const settings = parseActivity(value);
        if (id !== undefined) {
            const previous = await this.load(id); // 修改不能偷偷建立另一個 ID。
            if (previous.settings.platform !== settings.platform) {
                throw new Error("不能變更既有活動的平台，請另建活動。");
            }
            if (previous.schemaVersion === 1) await this.backupLegacy(id);
        }

        // 建立要儲存的活動紀錄
        const record: ActivityRecord = {
            schemaVersion: 3,
            id: id ?? randomUUID(),
            updatedAt: new Date().toISOString(),
            settings,
        };

        // 寫入檔案
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(this.path(record.id), record);
        return record;
    }

    private async backupLegacy(id: string): Promise<void> {
        // 首次升版先保存原始位元組；備份失敗就不覆寫活動
        const source = await readFile(this.path(id));
        const backup = this.path(id) + ".v1.bak";
        try {
            await writeFile(backup, source, { flag: "wx", mode: 0o600 });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = await readFile(backup);
            if (!existing.equals(source)) throw new Error("舊活動備份與原檔不同，請先人工確認；未覆寫活動。");
        }
    }

    async remove(id: string): Promise<void> {
        await this.load(id);
        await unlink(this.path(id));
    }

    async list(): Promise<{ activities: ActivityRecord[]; invalidFiles: number }> {
        // 讀取資料夾；資料夾不存在就當作沒有活動
        const files = await readdir(this.directory).catch(error => {
            if (error.code === "ENOENT") return [];
            throw error;
        });

        // 逐一載入活動，並計算無效的檔案數
        const activities: ActivityRecord[] = [];
        let invalidFiles = 0;
        for (const file of files.filter(file => file.endsWith(".json"))) {
            try {
                activities.push(await this.load(file.slice(0, -5)));
            } catch {
                invalidFiles++;
            }
        }

        // 依更新時間排序，最新的在前
        return { activities: activities.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), invalidFiles };
    }
}
