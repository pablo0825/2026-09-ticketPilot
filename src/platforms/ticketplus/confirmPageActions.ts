import type { ElementHandle, Page } from "playwright";
import { readTicketPlusPageWithMarkers } from "./pageState.js";
import type { TicketPlusPageMarkers } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";

// 購票資料頁與抽選輸入資料頁共用的操作：勾條款、按一次下一步、等待下一頁。

export class TermsStop extends Error {
    constructor(readonly reason: "terms-missing" | "terms-unchecked") {
        super(reason);
    }
}

const termsPattern = /^我已經閱讀並同意\s*會員服務條款\s*與\s*隱私權政策$/;

// 剩餘時間取設定上限與全程期限較小者；沒有全程期限時只用設定上限。
export function bounded(control: TicketPlusRunControl, milliseconds: number): number {
    return Math.max(1, Math.min(milliseconds, control.remainingMs()));
}

// 條款的可點控制項：Vuetify 隱藏 input 的外層，沒有外層時才用 input 本身；不點 label 文字（內含條款連結）。
// 函式內只用行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。
function locateTermsControl(pattern: string): Element | null {
    const matcher = new RegExp(pattern);
    const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]')).filter(input =>
        Array.from((input as HTMLInputElement).labels ?? []).some(label =>
            matcher.test((label.textContent ?? "").replace(/\s+/g, " ").trim()),
        ),
    );
    if (inputs.length !== 1) return null;
    return inputs[0]!.closest(".v-input--selection-controls__input") ?? inputs[0]!;
}

// 勾選服務條款：已勾就不點；點一次後核對已勾選，未勾選也不再點第二次。
export async function checkTicketPlusTerms(
    page: Page,
    control: TicketPlusRunControl,
    isChecked: () => Promise<boolean>,
    clickTimeoutMs = 5_000,
): Promise<void> {
    // 已勾選就不點。
    if (await isChecked()) return;

    // 定位條款控制項並點一次；點擊錯誤也不重點。
    const handle = await control.read(() => page.evaluateHandle(locateTermsControl, termsPattern.source));
    const target = handle.asElement();
    if (!target) {
        await handle.dispose().catch(() => {});
        throw new TermsStop("terms-missing");
    }
    try {
        control.check();
        await target.click({ timeout: bounded(control, clickTimeoutMs) });
    } catch (error) {
        if (error instanceof TicketPlusStopError) throw error;
        throw new TermsStop("terms-unchecked");
    } finally {
        await target.dispose().catch(() => {});
    }

    // 點後核對已勾選；未勾選也不再點第二次。
    if (!(await isChecked())) throw new TermsStop("terms-unchecked");
}

// 固定唯一可見的「下一步」節點（與快照相同定義），點擊前以 recheck 再核對頁面，只按一次。
// markAttempt 在真正點擊前呼叫，讓呼叫端區分點擊前停止與點擊後未確認。
export async function pressNextOnce(
    page: Page,
    control: TicketPlusRunControl,
    recheck: () => Promise<boolean>,
    clickTimeoutMs: number,
    markAttempt: () => void,
): Promise<"clicked" | "unavailable"> {
    const locator = page.getByRole("button", { name: "下一步", exact: true }).filter({ visible: true });
    if ((await control.read(() => locator.count())) !== 1) return "unavailable";
    let handle: ElementHandle | null = null;
    try {
        handle = await control.read(() => locator.elementHandle({ timeout: bounded(control, clickTimeoutMs) }));
        if (!(await recheck())) return "unavailable";
        const timeout = bounded(control, clickTimeoutMs);
        markAttempt();
        await handle.click({ timeout });
        return "clicked";
    } finally {
        await handle?.dispose().catch(() => {});
    }
}

// 按下一步後等待下一頁的標記符合 accept；期限內沒到回傳 false，不重按。
export async function waitForMarkers(
    page: Page,
    control: TicketPlusRunControl,
    accept: (markers: TicketPlusPageMarkers | undefined) => boolean,
    options: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
    const deadline = performance.now() + bounded(control, options.timeoutMs ?? 15_000);
    while (performance.now() < deadline) {
        const after = await control.read(() => readTicketPlusPageWithMarkers(page)).catch(() => undefined);
        if (accept(after?.markers)) return true;
        await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 100, deadline - performance.now())));
    }
    return false;
}
