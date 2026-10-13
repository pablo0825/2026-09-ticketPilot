// 保留票種名稱中的括號、VIP 與數字，只正規化全形及空白。
export function normalizeTicketName(text: string): string {
    return text.normalize("NFKC").replace(/\s/g, "");
}

// 只分離明確的尾端價格展示，不解析或核對幣種、數值。
// 純金額也可作為完整票種名稱；不明後綴保留，避免誤刪票種限定。
export function parseTicketLabel(text: string): { name: string } {
    const label = text.normalize("NFKC").trim();
    const money =
        /^(?:NT\$|HK\$|US\$|(?:TWD|HKD|USD|EUR|GBP|JPY|CNY|RMB|KRW|SGD|AUD|CAD|MOP)\s*|\p{Sc})\s*[-+]?\d[\d,.]*(?:\s*起)?$/u;
    const suffix =
        label.match(/^(.+?)\s*\(([^()]*)\)$/) ??
        label.match(/^(.+?)\s+((?:NT\$|HK\$|US\$|TWD|HKD|USD|EUR|GBP|JPY|CNY|RMB|KRW|SGD|AUD|CAD|MOP|\p{Sc}).*)$/u);
    const name = normalizeTicketName(suffix && money.test(suffix[2]!.trim()) ? suffix[1]! : label);
    if (!name) throw new Error("票種名稱缺少或無法辨識。");
    return { name };
}
