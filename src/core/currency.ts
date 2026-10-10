// 幣別資料同時供設定、紀錄與介面使用；不包含網站格式。
export const currencies = {
    TWD: { label: "台幣", symbol: "NT$" },
    HKD: { label: "港幣", symbol: "HK$" },
} as const;

export type Currency = keyof typeof currencies;
export interface Money {
    currency: Currency;
    amount: number;
}

export function isCurrency(value: unknown): value is Currency {
    return typeof value === "string" && Object.hasOwn(currencies, value);
}

export function validateMoney(value: Money): void {
    if (!isCurrency(value.currency)) throw new Error("預期幣別不支援。");
    if (!Number.isSafeInteger(value.amount) || value.amount <= 0) {
        throw new Error("預期金額必須是安全範圍內的正整數。");
    }
}

export function verifyMoney(actual: Money, expected: Money): void {
    validateMoney(expected);
    if (actual.currency !== expected.currency) throw new Error("幣別不符。");
    if (actual.amount !== expected.amount) throw new Error("金額不符。");
}
