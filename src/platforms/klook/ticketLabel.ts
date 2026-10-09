// 網站文字格式由 Klook 層解析；保留名稱中的 VIP、單人票等限定內容。
export function normalizeTicketName(text: string): string {
    return text.normalize("NFKC").replace(/\s/g, "");
}

export function parseTicketAmount(text: string): number {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error("票價格式無法辨識。");
    const amount = Number(text.replace(/,/g, ""));
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("票價必須是安全範圍內的正整數。");
    return amount;
}

export function parseTicketLabel(text: string): { name: string; unitPrice: number } {
    const label = text.normalize("NFKC").trim();
    // 僅接受已觀察的三種後綴；不移除名稱裡其他括號或數字。
    const match = label.match(/^(.+?)\s*\(NT\$\s*([\d,]+)\)$/) ?? label.match(/^(.+?)\s+(?:NT\$|\$)\s*([\d,]+)$/);
    if (!match || !normalizeTicketName(match[1]!)) throw new Error("票種名稱或價格格式無法辨識。");
    return { name: normalizeTicketName(match[1]!), unitPrice: parseTicketAmount(match[2]!) };
}
