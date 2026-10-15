import { parseTicketPlusActivity } from "../../../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";
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
    targets: TargetDraft[];
    maxRunMinutes: string;
}

export interface ScheduleForm {
    mode: "now" | "scheduled";
    saleAt: string;
    advanceSeconds?: 1 | 2;
}

export function scheduleForm(settings?: TicketPlusActivitySettings): ScheduleForm {
    const schedule = settings?.saleSchedule;
    return {
        mode: schedule ? "scheduled" : "now",
        saleAt: schedule?.saleAt.slice(0, 19) ?? "",
        ...(schedule?.advanceSeconds !== undefined ? { advanceSeconds: schedule.advanceSeconds } : {}),
    };
}

function withSeconds(value: string): string {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? value + ":00" : value;
}

export function scheduleFingerprint(form: ScheduleForm): string {
    return JSON.stringify({ mode: form.mode, saleAt: withSeconds(form.saleAt), advanceSeconds: form.advanceSeconds });
}

// 時間輸入固定視為台灣時間，不經過瀏覽器所在時區轉換。
export function scheduleInput(form: ScheduleForm, saved: TicketPlusActivitySettings): TicketPlusActivitySettings {
    const { saleSchedule: _previous, ...activity } = saved;
    return parseTicketPlusActivity({
        ...activity,
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
        targets: settings?.targets.map(target => ({
            ...target,
            key: crypto.randomUUID(),
            quantity: String(target.quantity),
        })) ?? [emptyTarget()],
        maxRunMinutes: settings?.maxRunMinutes === undefined ? "" : String(settings.maxRunMinutes),
    };
}

// 草稿比較不驗證必填欄位，也不比較只用於 React 的識別碼。
export function draftFingerprint(form: ActivityForm): string {
    return JSON.stringify({
        eventName: form.eventName,
        eventUrl: form.eventUrl,
        maxRunMinutes: form.maxRunMinutes,
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
    // 明列 TicketPlus 欄位；隱藏的排程完整保留，不做時區轉換。
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
        ...(saved?.saleSchedule ? { saleSchedule: { ...saved.saleSchedule } } : {}),
    };
    if (form.maxRunMinutes.trim()) {
        const minutes = positiveInteger(form.maxRunMinutes, "最長執行時間");
        if (minutes > 1440) throw new Error("最長執行時間必須為 1～1440 整數分鐘。");
        settings.maxRunMinutes = minutes;
    }
    return parseTicketPlusActivity(settings);
}

// API 泛型不是執行期驗證，載入與保存回應都需確認平台及紀錄識別。
export function ticketPlusRecord(value: unknown, expectedId?: string): TicketPlusActivityRecord {
    if (!value || typeof value !== "object") throw new Error("無法確認 TicketPlus 活動紀錄。");
    const record = value as Record<string, unknown>;
    if (
        (record.schemaVersion !== 1 && record.schemaVersion !== 3) ||
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
