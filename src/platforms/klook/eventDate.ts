import { PurchaseStop } from "../../core/purchaseStop.js";

export interface DateOption {
    year: number | null;
    month: number;
    day: number;
}

// 日期選項只接受完整已知格式；不從活動文案或星期推算年份。
export function parseDateOption(text: string): DateOption {
    // 比對中文或數字日期格式
    const value = text.normalize("NFKC").trim();
    const suffix = String.raw`\s*(?:\((?:週|星期)?[一二三四五六日天]\))?\s*$`;
    const chinese = value.match(new RegExp(String.raw`^(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日` + suffix));
    const numeric = value.match(new RegExp(String.raw`^(\d{4})\s*([/.-])\s*(\d{1,2})\s*\2\s*(\d{1,2})` + suffix));
    if (!chinese && !numeric) throw new PurchaseStop("日期選項格式無法辨識，已停止；不猜測日期。");

    // 取出年、月、日
    const year = chinese ? (chinese[1] ? Number(chinese[1]) : null) : Number(numeric![1]);
    const month = Number(chinese ? chinese[2] : numeric![3]);
    const day = Number(chinese ? chinese[3] : numeric![4]);

    // 無年份時用閏年檢查月日是否可能存在；不把檢查用年份視為演出年份。
    const iso = `${String(year ?? 2000).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (year === 0 || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
        throw new PurchaseStop("日期選項日期不存在，已停止。");
    }

    return { year, month, day };
}

export function matchesDateOption(option: DateOption, expected: string): boolean {
    const [year, month, day] = expected.split("-").map(Number);
    return (option.year === null || option.year === year) && option.month === month && option.day === day;
}
