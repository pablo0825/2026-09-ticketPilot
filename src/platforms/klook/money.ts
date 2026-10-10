import { currencies } from "../../core/currency.js";
import type { Currency, Money } from "../../core/currency.js";

export function parseTicketAmount(text: string): number {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error("票價格式無法辨識。");
    const amount = Number(text.replace(/,/g, ""));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("票價必須是安全範圍內的正整數。");
    return amount;
}

// 金額欄位必須含明確幣別；裸 $ 的舊格式只由票種解析器處理。
export function parseMoney(text: string): Money {
    const value = text.normalize("NFKC").trim();
    for (const currency of Object.keys(currencies) as Currency[]) {
        const symbol = currencies[currency].symbol;
        if (value.startsWith(symbol)) {
            return { currency, amount: parseTicketAmount(value.slice(symbol.length).trim()) };
        }
    }
    throw new Error("價格幣別或格式無法辨識。");
}
