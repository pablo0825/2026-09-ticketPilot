import type { ActivitySettings } from "../../../../config/activityStore.js";
import type { ContactDetails } from "../../../../config/contact.config.js";

export interface TargetDraft {
    key: string;
    date: string;
    time: string;
    area: string;
    quantity: string;
    adjacent: boolean;
    bundle: string;
}

export interface ActivityForm {
    eventName: string;
    eventUrl: string;
    exclude: string;
    queueEnabled: boolean;
    bundleEnabled: boolean;
    deliveryMethod: string;
    targets: TargetDraft[];
    mode: "now" | "scheduled";
    saleAt: string;
    advance: string;
}

export type ActivityDraft = Omit<ActivitySettings, "saleSchedule"> & {
    saleSchedule?: { saleAt: string; advanceSeconds?: number };
};

export function emptyTarget(): TargetDraft {
    return { key: crypto.randomUUID(), date: "", time: "", area: "", quantity: "1", adjacent: false, bundle: "" };
}

export function activityForm(settings?: ActivitySettings): ActivityForm {
    // 還原活動與順位，草稿張數保留字串以容許暫時空白
    const targets = settings?.targets.map(target => ({
        ...emptyTarget(),
        ...target,
        quantity: String(target.quantity),
        adjacent: target.quantity > 1 && target.adjacent,
        bundle: target.bundle ?? "",
    })) ?? [emptyTarget()];

    // 開賣欄位使用台灣時間文字，避免作業系統時區轉換
    return {
        eventName: settings?.eventName ?? "",
        eventUrl: settings?.eventUrl ?? "",
        exclude: settings?.excludeKeywords.join(",") ?? "愛心席,身障,視線不良",
        queueEnabled: settings?.queueEnabled === true,
        bundleEnabled: settings?.bundleEnabled === true,
        deliveryMethod: settings?.deliveryMethod ?? "",
        targets,
        mode: settings?.saleSchedule ? "scheduled" : "now",
        saleAt: settings?.saleSchedule?.saleAt.slice(0, 19) ?? "",
        advance: String(settings?.saleSchedule?.advanceSeconds ?? 1),
    };
}

export function activityInput(form: ActivityForm, includeSchedule = true): ActivityDraft {
    // 明列儲存欄位及顺序，不把畫面識別碼送到後端
    const settings: ActivityDraft = {
        eventUrl: form.eventUrl.trim(),
        eventName: form.eventName.trim(),
        fallbackMode: "STRICT",
        excludeKeywords: form.exclude
            .split(/[,，]/)
            .map(value => value.trim())
            .filter(Boolean),
        targets: form.targets.map(target => ({
            date: target.date,
            time: target.time,
            area: target.area,
            quantity: Number(target.quantity),
            adjacent: target.adjacent,
            ...(form.bundleEnabled ? { bundle: target.bundle.trim() } : {}),
        })),
    };

    // 第三步才驗證及保存開賣設定
    if (includeSchedule && form.mode === "scheduled") {
        if (!form.saleAt) throw new Error("請填寫開賣時間。");
        settings.saleSchedule = {
            saleAt: (form.saleAt.length === 16 ? form.saleAt + ":00" : form.saleAt) + "+08:00",
            advanceSeconds: Number(form.advance),
        };
    }
    if (form.queueEnabled) settings.queueEnabled = true;
    if (form.bundleEnabled) settings.bundleEnabled = true;
    if (form.deliveryMethod.trim()) settings.deliveryMethod = form.deliveryMethod.trim();
    return settings;
}

export function needsActivitySave(form: ActivityForm, saved: ActivitySettings | null): boolean {
    if (!saved) return true;
    const { saleSchedule, ...fields } = saved;
    return JSON.stringify(activityInput(form, false)) !== JSON.stringify(fields);
}

export const emptyContact: ContactDetails = {
    firstName: "",
    lastName: "",
    regionLabel: "台灣 (+886)",
    phone: "",
    email: "",
};

export function contactInput(contact: ContactDetails): ContactDetails {
    return {
        firstName: contact.firstName.trim(),
        lastName: contact.lastName.trim(),
        regionLabel: contact.regionLabel.trim(),
        phone: contact.phone.trim(),
        email: contact.email.trim(),
    };
}
