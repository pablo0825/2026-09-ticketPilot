import type { BookingExpectation, PurchaseConfig, SaleSchedule, TicketTarget } from "./types.js";

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
    if (!expected || !expected.eventName.trim()) throw new Error("請設定預期活動名稱。");
    if (![expected.unitPrice, expected.totalPrice].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new Error("預期單價與總價必須是正整數新台幣金額。");
    }
}

export function validatePurchaseConfig(config: PurchaseConfig): void {
    if (config.saleSchedule !== undefined) validateSaleSchedule(config.saleSchedule);
    if (config.fallbackMode !== "STRICT" || config.targets.length === 0) {
        throw new Error("必須設定 STRICT 與至少一個目標。");
    }

    for (const target of config.targets) {
        validateTicketTarget(target);

        const normalize = (text: string) => text.normalize("NFKC").replace(/\s/g, "");
        const area = normalize(target.area);
        if (config.excludeKeywords.some(word => normalize(word) && area.includes(normalize(word)))) {
            throw new Error("目標票區符合排除條件。");
        }

        validateBookingExpectation(target.expectation);
    }
}

export function validateSaleSchedule(schedule: SaleSchedule): number {
    // 確認開賣時間的格式
    const value = schedule?.saleAt;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\+08:00$/.test(value)) {
        throw new Error("開賣時間必須包含日期、秒與台灣時區 +08:00。");
    }

    // 確認日期真的存在，例如不能是 2 月 30 日
    const timestamp = Date.parse(value);
    if (
        !Number.isFinite(timestamp) ||
        new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 19) !== value.slice(0, 19)
    ) {
        throw new Error("開賣日期無效。");
    }

    // 提前刷新只能 1 或 2 秒
    if (schedule.advanceSeconds !== undefined && schedule.advanceSeconds !== 1 && schedule.advanceSeconds !== 2) {
        throw new Error("提前刷新只能設定 1 或 2 秒。");
    }

    return timestamp;
}
