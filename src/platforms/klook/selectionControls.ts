import type { Page } from "playwright";
import type { TicketTarget } from "../../core/types.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { withSelectionLayout } from "./selectionDom.js";
import type { QuantityState, SelectionSnapshot } from "./selectionDom.js";
import { pollSelection, SelectionWaitTimeout } from "./selectionPolling.js";

export function readQuantityState(snapshot: SelectionSnapshot): QuantityState | undefined {
    if (snapshot.quantities.length > 1) throw new Error("票券數量列有多個匹配項，已停止。");
    const quantity = snapshot.quantities[0];
    if (quantity && (quantity.valueCount > 1 || (quantity.valueCount === 1 && quantity.value === null)))
        throw new Error("數量值不唯一或格式不合法，已停止。");
    return quantity;
}

export function readAdjacentState(snapshot: SelectionSnapshot): boolean {
    if (snapshot.adjacent.length !== 1 || snapshot.adjacent[0] === null) {
        throw new PurchaseStop("找不到唯一且狀態明確的相連座位設定，已停止。");
    }
    return snapshot.adjacent[0]!;
}

export function verifySelectionControls(snapshot: SelectionSnapshot, target: TicketTarget): void {
    if (readQuantityState(snapshot)?.value !== target.quantity) throw new PurchaseStop("最終票數不一致。");
    if (target.quantity > 1 && readAdjacentState(snapshot) !== target.adjacent) {
        throw new PurchaseStop("最終相連座位設定不一致。");
    }
}

interface ControlQuery {
    control: "plus" | "minus" | "adjacent";
    value: number | boolean;
}

const locateControl = withSelectionLayout((findLayout, query: ControlQuery) => {
    const layout = findLayout();
    if (layout.roots.length !== 1 || layout.loading) return null;
    if (query.control === "adjacent") {
        if (layout.adjacent.length !== 1) return null;
        const box = layout.adjacent[0]!;
        const inputs = box.querySelectorAll("input");
        const input = inputs[0];
        if (
            inputs.length !== 1 ||
            !(input instanceof HTMLInputElement) ||
            input.type !== "checkbox" ||
            input.indeterminate ||
            input.checked !== query.value
        )
            return null;
        const aria = box.getAttribute("aria-checked");
        if (input.checked ? aria !== "true" : aria !== null && aria !== "false") return null;
        return box;
    }
    if (layout.quantities.length !== 1) return null;
    const quantity = layout.quantities[0]!;
    if (!quantity.value || Number(quantity.value.textContent?.trim()) !== query.value) return null;
    const buttons = quantity[query.control];
    if (buttons.length !== 1) return null;
    const button = buttons[0]!;
    if (button.classList.contains("btnDisabled-O7fKf4") || button.matches(':disabled, [aria-disabled="true"]'))
        return null;
    return button;
});

// 每次增減只點一次，再等精確的一張變化；不以再次點擊修補未知結果。
export class KlookSelectionControls {
    constructor(
        private readonly page: Page,
        private readonly timeout: number,
        private readonly observeNotice: () => Promise<void>,
    ) {}

    async select(target: TicketTarget): Promise<void> {
        let snapshot = await this.wait(data => readQuantityState(data)?.value != null, "票券數量列尚未完整");
        let quantity = readQuantityState(snapshot)!;
        if (quantity.limit === null) throw new Error("無法確認單次購買數量上限，已停止。");
        if (target.quantity > quantity.limit) throw new Error(`目標票數超過 UI 上限 ${quantity.limit} 張。`);
        while (quantity.value !== target.quantity) {
            const current = quantity.value!;
            const increase = current < target.quantity;
            await this.click({ control: increase ? "plus" : "minus", value: current });
            const expected = current + (increase ? 1 : -1);
            snapshot = await this.wait(data => readQuantityState(data)?.value === expected, "數量點選後未更新");
            quantity = readQuantityState(snapshot)!;
        }
        if (target.quantity === 1) return;
        snapshot = await this.wait(data => {
            if (!data.adjacent.length) return false;
            readAdjacentState(data);
            return true;
        }, "相連座位設定尚未完整");
        const current = readAdjacentState(snapshot);
        if (current !== target.adjacent) {
            await this.click({ control: "adjacent", value: current });
            await this.wait(data => readAdjacentState(data) === target.adjacent, "相連座位設定未更新");
        }
    }

    private async wait(check: (snapshot: SelectionSnapshot) => boolean, message: string): Promise<SelectionSnapshot> {
        try {
            return await pollSelection(this.page, check, message, this.observeNotice, this.timeout);
        } catch (error) {
            // 張數與連位的等待逾時沿用原一般錯誤；observer 的停止／過期錯誤不改分類。
            if (error instanceof SelectionWaitTimeout) throw new Error(error.message, { cause: error });
            throw error;
        }
    }

    private async click(query: ControlQuery): Promise<void> {
        await this.observeNotice();
        const handle = await this.page.evaluateHandle(locateControl, query);
        try {
            const element = handle.asElement();
            if (!element) {
                if (query.control === "adjacent") throw new PurchaseStop("相連座位狀態已變動或不唯一，已停止。");
                throw new Error("數量按鈕目前停用、已變動或不唯一，已停止。");
            }
            await element.click({ timeout: this.timeout });
        } finally {
            await handle.dispose();
        }
    }
}
