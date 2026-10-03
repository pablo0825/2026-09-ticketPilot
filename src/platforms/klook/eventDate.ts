import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";

// 只解析完整、年在前的日期；不猜測省略年份、日期區間或日/月順序。
export function parseEventDate(text: string): string {
    const value = text.normalize("NFKC").trim();
    const suffix = String.raw`\s*(?:\((?:週|星期)?[一二三四五六日天]\))?\s*$`;
    const match = value.match(new RegExp(String.raw`^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日` + suffix))
        ?? value.match(new RegExp(String.raw`^(\d{4})\s*([/.-])\s*(\d{1,2})\s*\2\s*(\d{1,2})` + suffix));
    if (!match) throw new PurchaseStop("演出日期格式不支援或缺少年份，已停止；不猜測日期。");
    const year = Number(match[1]);
    // 數字分隔格式額外捕獲分隔符，確保前後使用相同符號。
    const numeric = match.length === 5;
    const month = Number(match[numeric ? 3 : 2]);
    const day = Number(match[numeric ? 4 : 3]);
    const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    if (year < 1 || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
        throw new PurchaseStop("演出日期不存在，已停止。");
    }
    return iso;
}

// 實站 BOYFRIEND「活動日期｜」與斑恩「時間｜」均位於 #ticket-info 的段落。
// 只採用明確日期欄位；售票／取票文字、其他區塊及未標記段落不作為證據。
export async function verifyEventDate(page: Page, expected: string, timeout: number): Promise<void> {
    const info = page.locator("#ticket-info").filter({ visible: true });
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        // 同一次同步讀取完成容器判斷、標題層級與文字；不跨次保留 DOM 節點。
        // evaluateAll 在容器消失時回傳空集合，不另啟動 locator 的預設等待。
        const snapshot = await info.evaluateAll(containers => {
            if (containers.length !== 1) return { count: containers.length, rows: [] };
            const container = containers[0]!;
            if (!container.isConnected) return { count: 0, rows: [] };
            const headings: { level: number; text: string }[] = [];
            const rows: { sections: string[]; text: string }[] = [];
            for (const node of container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6, p, li")) {
                if (/^H[1-6]$/.test(node.tagName)) {
                    const text = node.textContent?.trim();
                    if (text) {
                        const level = Number(node.tagName[1]);
                        while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
                        headings.push({ level, text });
                    }
                    continue;
                }
                // CSS 隱藏（含祖先 display:none）及無可見尺寸的段落都不採用。
                const style = getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                if (style.visibility === "hidden" || style.visibility === "collapse" || rect.width <= 0 || rect.height <= 0) continue;
                rows.push({ sections: headings.map(heading => heading.text), text: node.innerText });
            }
            return { count: 1, rows };
        });
        if (Date.now() >= deadline) break;
        if (snapshot.count > 1) throw new PurchaseStop("演出日期資訊區塊不唯一，已停止。");
        if (snapshot.count === 1) {
            const dates: string[] = [];
            for (const row of snapshot.rows) {
                if (row.sections.some(section => /售票|開賣|取票|退票|退款|登記/.test(section))) continue;
                const text = row.text.normalize("NFKC").trim();
                const field = text.match(/^[^\p{L}\p{N}]*(活動日期|演出日期|日期|演出時間|時間)\s*[|:]\s*(.+)$/u);
                if (!field) continue;
                // 「演出時間｜17:00 開始」只是時間，不能當成完整日期。
                if (/^(演出時間|時間)$/.test(field[1]!) && /^\d{1,2}:\d{2}(?:\s|$)/.test(field[2]!)) continue;
                dates.push(parseEventDate(field[2]!));
            }
            if (dates.length > 0) {
                if (new Set(dates).size !== 1) throw new PurchaseStop("演出日期資訊互相矛盾或含多個日期，已停止。");
                if (dates[0] !== expected) throw new PurchaseStop(`演出日期不符：預期 ${expected}，實際 ${dates[0]}。`);
                return;
            }
        }
        const remaining = deadline - Date.now();
        if (remaining > 0) await page.waitForTimeout(Math.min(200, remaining));
    }
    throw new PurchaseStop("未能讀取明確的演出日期欄位，已停止；不使用開賣日或取票日推測。");
}
