import { validateSaleSchedule } from "../../../../core/saleSchedule.js";
import {
    parseTicketPlusActivity,
    ticketPlusDefaultRunMinutes,
    ticketPlusFlowType,
    validateTicketPlusRunSettings,
} from "../../../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings, TicketPlusFlowType } from "../../../../config/ticketPlusActivity.js";
import type { ActivityRecord } from "../../../../config/activityStore.js";

export type TicketPlusActivityRecord = ActivityRecord & { settings: TicketPlusActivitySettings };
export interface TargetDraft {
    key: string;
    date: string;
    time: string;
    ticketType: string;
    quantity: string;
}
export interface ActivityForm {
    eventName: string;
    eventUrl: string;
    flowType: TicketPlusFlowType;
    targets: TargetDraft[];
}

export interface ExecutionForm {
    mode: "now" | "scheduled";
    saleAt: string;
    advanceSeconds?: 1 | 2;
    maxRunMinutes: string;
}

export type ExecutionErrors = Partial<Record<"saleAt" | "maxRunMinutes", string>>;

export function executionErrors(form: ExecutionForm): ExecutionErrors {
    const errors: ExecutionErrors = {};
    // 依畫面順序核對欄位，時間固定使用台灣時區。
    if (form.mode === "scheduled") {
        try {
            validateSaleSchedule({ saleAt: withSeconds(form.saleAt) + "+08:00" });
        } catch {
            errors.saleAt = "請填寫有效的開賣日期與時間。";
        }
    }

    // 期限沿用整數規則，欄位錯誤不取代正式啟動驗證。
    const minutes = Number(form.maxRunMinutes);
    if (
        !/^\d+$/.test(form.maxRunMinutes.trim()) ||
        !Number.isSafeInteger(minutes) ||
        minutes < ticketPlusDefaultRunMinutes ||
        minutes > 1440
    ) {
        errors.maxRunMinutes = "請填寫 10～1440 的整數分鐘。";
    }
    return errors;
}

export function executionForm(settings?: TicketPlusActivitySettings): ExecutionForm {
    const schedule = settings?.saleSchedule;
    return {
        maxRunMinutes: String(settings?.maxRunMinutes ?? ticketPlusDefaultRunMinutes),
        mode: schedule ? "scheduled" : "now",
        saleAt: schedule?.saleAt.slice(0, 19) ?? "",
        ...(schedule?.advanceSeconds !== undefined ? { advanceSeconds: schedule.advanceSeconds } : {}),
    };
}

function withSeconds(value: string): string {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value + ":00" : value;
}

export function executionFingerprint(form: ExecutionForm): string {
    return JSON.stringify({
        mode: form.mode,
        saleAt: withSeconds(form.saleAt),
        advanceSeconds: form.advanceSeconds,
        maxRunMinutes: form.maxRunMinutes,
    });
}

// 時間輸入固定視為台灣時間，不經過瀏覽器所在時區轉換。
export function executionInput(form: ExecutionForm, saved: TicketPlusActivitySettings): TicketPlusActivitySettings {
    const { saleSchedule: _previous, maxRunMinutes: _previousMinutes, ...activity } = saved;
    const minutes = positiveInteger(form.maxRunMinutes, "最長執行時間");
    validateTicketPlusRunSettings({ ...saved, maxRunMinutes: minutes });
    return parseTicketPlusActivity({
        ...activity,
        maxRunMinutes: minutes,
        ...(form.mode === "scheduled"
            ? {
                  saleSchedule: {
                      saleAt: withSeconds(form.saleAt) + "+08:00",
                      ...(form.advanceSeconds !== undefined ? { advanceSeconds: form.advanceSeconds } : {}),
                  },
              }
            : {}),
    });
}

export function emptyTarget(): TargetDraft {
    return { key: crypto.randomUUID(), date: "", time: "", ticketType: "", quantity: "1" };
}

export function activityForm(settings?: TicketPlusActivitySettings): ActivityForm {
    return {
        eventName: settings?.eventName ?? "",
        eventUrl: settings?.eventUrl ?? "",
        flowType: settings ? ticketPlusFlowType(settings) : "purchase",
        targets: settings?.targets.map(target => ({
            ...target,
            key: crypto.randomUUID(),
            quantity: String(target.quantity),
        })) ?? [emptyTarget()],
    };
}

// 草稿比較不驗證必填欄位，也不比較只用於 React 的識別碼。
export function draftFingerprint(form: ActivityForm): string {
    return JSON.stringify({
        eventName: form.eventName,
        eventUrl: form.eventUrl,
        flowType: form.flowType,
        targets: form.targets.map(({ key: _key, ...target }) => target),
    });
}

function positiveInteger(value: string, label: string): number {
    const text = value.trim();
    const number = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1) throw new Error(`${label}必須為正整數。`);
    return number;
}

export function activityInput(form: ActivityForm, saved?: TicketPlusActivitySettings): TicketPlusActivitySettings {
    // 明列 TicketPlus 欄位；已保存的執行設定完整保留，不做時區轉換。
    const settings: TicketPlusActivitySettings = {
        platform: "ticketplus",
        eventName: form.eventName.trim(),
        eventUrl: form.eventUrl.trim(),
        targets: form.targets.map((target, index) => ({
            date: target.date,
            time: target.time,
            ticketType: target.ticketType.trim(),
            quantity: positiveInteger(target.quantity, `順位 ${index + 1} 的張數`),
        })),
        // 購票是預設值，不寫入設定，舊活動重新存檔時歷史指紋不變。
        ...(form.flowType === "lottery" ? { flowType: "lottery" as const } : {}),
        ...(saved?.maxRunMinutes === undefined ? {} : { maxRunMinutes: saved.maxRunMinutes }),
        ...(saved?.saleSchedule ? { saleSchedule: { ...saved.saleSchedule } } : {}),
    };
    return parseTicketPlusActivity(settings);
}

// API 泛型不是執行期驗證，載入與保存回應都需確認平台及紀錄識別。
export function ticketPlusRecord(value: unknown, expectedId?: string): TicketPlusActivityRecord {
    if (!value || typeof value !== "object") throw new Error("無法確認 TicketPlus 活動紀錄。");
    const record = value as Record<string, unknown>;
    if (
        record.schemaVersion !== 3 ||
        typeof record.id !== "string" ||
        !/^[A-Za-z0-9-]+$/.test(record.id) ||
        (expectedId !== undefined && record.id !== expectedId) ||
        typeof record.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(record.updatedAt))
    ) {
        throw new Error("活動紀錄識別或版本不符，請重新載入。");
    }
    return {
        schemaVersion: record.schemaVersion,
        id: record.id,
        updatedAt: record.updatedAt,
        settings: parseTicketPlusActivity(record.settings),
    };
}
