import { currencies } from "../../core/currency.js";
import type { Currency } from "../../core/currency.js";
import { parseMoney } from "./money.js";

// 網站文字格式由 Klook 層解析；保留名稱中的 VIP、單人票等限定內容。
export function normalizeTicketName(text: string): string {
    return text.normalize("NFKC").replace(/\s/g, "");
}

export { parseTicketAmount } from "./money.js";

export function parseTicketLabel(text: string): { name: string; unitPrice: number; currency: Currency } {
    const label = text.normalize("NFKC").trim();
    const match = label.match(/^(.+?)\s*\(([^()]*)\)$/) ?? label.match(/^(.+?)\s+(\S+?\s*[\d,]+)$/);
    if (!match || !normalizeTicketName(match[1]!)) throw new Error("票種名稱或價格格式無法辨識。");

    // 只保留既有無括號票種後綴的裸 $ 台幣相容範圍。
    const price = match[2]!;
    const legacy = !label.endsWith(")") && /^\$\s*[\d,]+$/.test(price);
    const money = parseMoney(legacy ? `${currencies.TWD.symbol}${price.slice(1)}` : price);
    return { name: normalizeTicketName(match[1]!), unitPrice: money.amount, currency: money.currency };
}
