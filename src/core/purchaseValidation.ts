import { validateSaleSchedule } from "./saleSchedule.js";
import type { BookingExpectation, PurchaseConfig, PurchaseConfigInput, TicketTarget } from "./types.js";

// 設定的純規則集中於此；操作前與摘要核對前仍各自呼叫，不讀取 DOM。
export function validateTicketTarget(target: TicketTarget): void {
    const date = new Date(`${target.date}T00:00:00Z`);
    if (
        !/^\d{4}-\d{2}-\d{2}$/.test(target.date) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== target.date
    ) {
        throw new Error("日期格式或日期無效。");
    }

    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(target.time)) throw new Error("時間格式無效。");
    if (!Number.isSafeInteger(target.quantity) || target.quantity < 1) throw new Error("票數必須是正整數。");
    if (!target.area.normalize("NFKC").trim()) throw new Error("票區不能為空。");
    if (typeof target.adjacent !== "boolean") throw new Error("連位設定必須是布林值。");
}

export function validateBookingExpectation(expected: BookingExpectation): void {
    if (!expected || typeof expected.eventName !== "string" || !expected.eventName.trim()) {
        throw new Error("請設定預期活動名稱。");
    }
}

export function validatePurchaseConfig(config: PurchaseConfig): void {
    if (config.queueEnabled !== undefined && typeof config.queueEnabled !== "boolean") {
        throw new Error("排隊開關必須是布林值。");
    }
    if (config.bundleEnabled !== undefined && typeof config.bundleEnabled !== "boolean") {
        throw new Error("套票開關必須是布林值。");
    }
    if (
        config.deliveryMethod !== undefined &&
        (typeof config.deliveryMethod !== "string" || !config.deliveryMethod.trim())
    ) {
        throw new Error("取票方式必須是非空文字。");
    }
    if (config.saleSchedule !== undefined) validateSaleSchedule(config.saleSchedule);
    if (config.fallbackMode !== "STRICT" || config.targets.length === 0) {
        throw new Error("必須設定 STRICT 與至少一個目標。");
    }

    for (const target of config.targets) {
        validateTicketTarget(target);
        if (target.bundle !== undefined && typeof target.bundle !== "string") {
            throw new Error("組合套票必須是文字。");
        }
        if (config.bundleEnabled && !target.bundle?.trim()) {
            throw new Error("啟用組合套票時，每個順位都必須填寫套票名稱。");
        }

        const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
        const area = normalize(target.area);
        if (config.excludeKeywords.some(word => normalize(word) && area.includes(normalize(word)))) {
            throw new Error("目標票區符合排除條件。");
        }

        validateBookingExpectation(target.expectation);
    }
}

export function normalizePurchaseConfig(input: PurchaseConfigInput): PurchaseConfig {
    // 複製設定，移除舊版金額欄位
    const snapshot = structuredClone(input);
    const config: PurchaseConfig = {
        ...snapshot,
        targets: snapshot.targets.map(target => ({
            ...target,
            expectation: {
                eventName: target.expectation?.eventName,
            },
        })),
    };

    // 啟動前檢查購票目標
    validatePurchaseConfig(config);
    if (!config.queueEnabled) delete config.queueEnabled;
    if (!config.bundleEnabled) {
        delete config.bundleEnabled;
        for (const target of config.targets) delete target.bundle;
    }
    return config;
}
