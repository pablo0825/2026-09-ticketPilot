import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { matchesDateOption, parseDateOption } from "./eventDate.js";
import { normalizeTicketName, parseTicketLabel } from "./ticketLabel.js";
import { withSelectionLayout } from "./selectionDom.js";
import type { SelectionOption, SelectionSnapshot } from "./selectionDom.js";
import { selectionGroup } from "./selectionPolling.js";

export type TargetGroup = "日期" | "時間" | "票種";

export function findTargetOption(
    snapshot: SelectionSnapshot,
    name: TargetGroup,
    wanted: string,
): SelectionOption | undefined {
    const group = selectionGroup(snapshot, name);
    if (!group || !group.options.length || group.options.some(option => !option.text)) return undefined;
    const matches = group.options.filter(option => {
        if (name === "日期") return matchesDateOption(parseDateOption(option.text), wanted);
        if (name === "時間") return option.text.trim() === wanted;
        return parseTicketLabel(option.text).name === normalizeTicketName(wanted);
    });
    if (matches.length > 1) throw new PurchaseStop(`${name}有多個匹配項，已停止。`);
    if (!matches.length && name === "時間") return undefined;
    if (!matches.length) throw new PurchaseStop(`${name}不符合目標，找不到符合完整名稱的選項；未判定售罄。`);
    return matches[0];
}

export function verifySelectedTarget(snapshot: SelectionSnapshot, name: TargetGroup, wanted: string): void {
    const option = findTargetOption(snapshot, name, wanted);
    if (!option) throw new PurchaseStop(`${name}資料不完整，已停止。`);
    if (option.disabled || option.soldOut || !option.enabled) {
        throw new PurchaseStop(
            name === "票種"
                ? "選票操作後票種變為停用，已停止；不送出。"
                : `${name}最終驗證發現停用，已停止；不換順位。`,
        );
    }
    if (!option.selected || selectionGroup(snapshot, name)?.options.filter(item => item.selected).length !== 1) {
        throw new PurchaseStop(`${name === "票種" ? "票區" : name}最終驗證不一致。`);
    }
}

interface OptionQuery {
    name: TargetGroup | "組合套票";
    expectedTexts?: string[];
    option: SelectionOption;
}

// 點擊前重跑找群組規則並核對剛讀到的文字與狀態，不依賴列表索引。
const locateOption = withSelectionLayout((findLayout, query: OptionQuery) => {
    const layout = findLayout();
    if (layout.roots.length !== 1 || layout.loading) return null;
    const groups = layout.groups.filter(group => group.name === query.name);
    if (groups.length !== 1) return null;
    if (query.expectedTexts) {
        const texts = groups[0]!.options.map(element =>
            element instanceof HTMLElement ? element.innerText.trim() : (element.textContent ?? "").trim(),
        );
        if (JSON.stringify(texts) !== JSON.stringify(query.expectedTexts)) return null;
    }
    const matches = groups[0]!.options.filter(element => {
        const text = element instanceof HTMLElement ? element.innerText.trim() : (element.textContent ?? "").trim();
        return text === query.option.text;
    });
    if (matches.length !== 1) return null;
    const element = matches[0]!;
    if (
        element.classList.contains("active-vB3nra") !== query.option.selected ||
        element.classList.contains("disabled-ImixBj") !== query.option.disabled ||
        element.classList.contains("soldout-sBHQQa") !== query.option.soldOut ||
        !element.matches(':disabled, [aria-disabled="true"]') !== query.option.enabled
    )
        return null;
    return element;
});

export async function clickTargetOption(
    page: Page,
    name: TargetGroup | "組合套票",
    option: SelectionOption,
    timeout: number,
    expectedTexts?: string[],
): Promise<void> {
    try {
        const handle = await page.evaluateHandle(locateOption, { name, option, expectedTexts });
        try {
            const element = handle.asElement();
            if (!element) throw new PurchaseStop(`${name}選項已變動或不唯一，已停止。`);
            await element.click({ timeout });
        } finally {
            await handle.dispose();
        }
    } catch (error) {
        if (error instanceof PurchaseStop || name === "票種") throw error;
        throw new PurchaseStop(`${name}選取結果未知，已停止；不重複點擊。`);
    }
}
