export interface SaleSchedule {
    saleAt: string; // 完整台灣時間，例如 2026-10-10T10:00:00+08:00。
    advanceSeconds?: 1 | 2; // 預設提前 1 秒刷新。
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
