import type { Locator, Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { queueRootSelector } from "./queuePage.js";

// 角色零匹配才使用文字備援；停用或多個角色不能繞過。
export async function findQueueControl(page: Page, name: string): Promise<Locator | undefined> {
    const root = page.locator(queueRootSelector).filter({ visible: true });
    const button = root.getByRole("button", { name, exact: true }).filter({ visible: true });
    const count = await button.count();
    if (count > 1) throw new PurchaseStop(`「${name}」按鈕不唯一，已停止。`);

    // 文字備援只接受本身或包含它的明確控制項，不猜任意父層
    let control = button;
    if (count === 0) {
        const text = root.getByText(name, { exact: true }).filter({ visible: true });
        const textCount = await text.count();
        if (textCount > 1) throw new PurchaseStop(`「${name}」文字不唯一，已停止。`);
        if (textCount === 0) return undefined;
        control = text.locator(
            'xpath=ancestor-or-self::*[self::button or self::a[@href] or @role="button" or @onclick][1]',
        );
        if ((await control.count()) !== 1) return undefined;
    }

    // 一般 div 的 isEnabled 不足以證明可操作，還要核對停用的祖先
    const allowed = await control.evaluate(
        (element, selector) => {
            if (!element.closest(selector)) return false;
            if (
                !element.matches(
                    'button, input[type="button"], input[type="submit"], a[href], [role="button"], [onclick]',
                )
            ) {
                return false;
            }
            for (let node: Element | null = element; node; node = node.parentElement) {
                if (node.matches(':disabled, [disabled], [aria-disabled="true"], [inert], .disabled, .is-disabled')) {
                    return false;
                }
                if (node.matches(selector)) return true;
            }
            return false;
        },
        queueRootSelector,
        { timeout: 1000 },
    );
    return allowed && (await control.isVisible()) && (await control.isEnabled()) ? control : undefined;
}
