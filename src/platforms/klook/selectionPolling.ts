import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { readSelectionDom } from "./selectionDom.js";
import type { SelectionGroup, SelectionSnapshot } from "./selectionDom.js";

export const selectionPollInterval = 200;
export const selectionWaitTimeout = 30_000;

export function selectionGroup(snapshot: SelectionSnapshot, name: string): SelectionGroup | undefined {
    const groups = snapshot.groups.filter(group => group.name === name);
    if (groups.length > 1) throw new PurchaseStop(`${name}群組有多個匹配項，已停止。`);
    return groups[0];
}

// 每個等待階段只有一個截止時間；提示錯誤原樣傳出，維持既有恢復資格。
export async function pollSelection(
    page: Page,
    check: (snapshot: SelectionSnapshot) => boolean,
    message: string,
    observeNotice: () => Promise<void>,
    timeout = selectionWaitTimeout,
): Promise<SelectionSnapshot> {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
        await observeNotice();
        let snapshot: SelectionSnapshot;
        try {
            snapshot = await readSelectionDom(page);
        } catch {
            throw new PurchaseStop("選票頁 DOM 讀取失敗，已停止；未判定售罄。");
        }
        await observeNotice();
        if (snapshot.rootCount > 1) throw new PurchaseStop("票券選擇區有多個匹配項，已停止。");
        if (performance.now() >= deadline) break;
        if (snapshot.rootCount === 1 && !snapshot.loading && check(snapshot)) return snapshot;
        await page.waitForTimeout(Math.max(0, Math.min(selectionPollInterval, deadline - performance.now())));
    }
    throw new PurchaseStop(`${message}；等待逾時，狀態未知，未判定售罄。`);
}

export function waitForTicketOptions(
    page: Page,
    observeNotice: () => Promise<void>,
    timeout = selectionWaitTimeout,
): Promise<SelectionSnapshot> {
    return pollSelection(
        page,
        snapshot => {
            // 先檢查全部群組的歧義，再判斷資料是否完整；不在收集階段點擊。
            const groups = ["日期", "時間", "票種"].map(name => selectionGroup(snapshot, name));
            return groups.every(
                group => group && group.options.length > 0 && group.options.every(option => option.text !== ""),
            );
        },
        "日期、時間或票種資料尚未完整",
        observeNotice,
        timeout,
    );
}
