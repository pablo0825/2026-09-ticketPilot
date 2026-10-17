import type { Page } from "playwright";
import { readTicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusDom } from "./domSnapshot.js";
import type { TicketPlusRunControl } from "./runControl.js";

export class TicketPlusNoticeError extends Error {
    constructor(readonly reason: "notice-dismiss-failed") {
        super("無法關閉活動頁提醒彈窗。");
    }
}

export interface ActivityNoticeOptions {
    // 點擊後等待彈窗消失的上限；開賣前沒有全程期限，必須自帶上限。
    timeoutMs?: number;
    // 消失後再觀察的時間，期間重現視為同一次載入又跳出。
    settleMs?: number;
    pollIntervalMs?: number;
}

type NoticeState = "none" | "notice" | "other";

function noticeState(dom: TicketPlusDom): NoticeState {
    if (dom.dialogs.length === 0) return "none";
    return dom.dialogs.length === 1 && dom.dialogs[0]!.kind === "notice" ? "notice" : "other";
}

// 在同一個提醒彈窗內找唯一可見且啟用的「確定」；找不到或不唯一回傳 null。
// 函式內只用物件方法與行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。
function locateConfirm(): Element | null {
    const dom = {
        visible(element: Element): boolean {
            const style = getComputedStyle(element);
            return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
        },
    };
    const dialogs = Array.from(document.querySelectorAll(".v-dialog")).filter(element => dom.visible(element));
    if (dialogs.length !== 1) return null;
    const buttons = Array.from(dialogs[0]!.querySelectorAll('button, [role="button"]')).filter(
        button =>
            dom.visible(button) &&
            !(button as HTMLButtonElement).disabled &&
            button.getAttribute("aria-disabled") !== "true" &&
            (button.textContent ?? "").trim() === "確定",
    );
    return buttons.length === 1 ? buttons[0]! : null;
}

// 關閉活動頁已知提醒：只按「確定」一次，確認消失且短時間內未重現；其他情況停止，不重點。
export async function dismissTicketPlusActivityNotice(
    page: Page,
    control: TicketPlusRunControl,
    options: ActivityNoticeOptions = {},
): Promise<"none" | "dismissed"> {
    const fail = () => new TicketPlusNoticeError("notice-dismiss-failed");
    const read = async () => noticeState(await control.read(() => readTicketPlusDom(page)));
    const pause = (milliseconds: number) => control.wait(Math.max(1, milliseconds));

    // 先確認目前只有一個已知提醒；沒有彈窗就不動作。
    const before = await read();
    if (before === "none") return "none";
    if (before === "other") throw fail();

    // 重新定位同規則的「確定」並點一次；點擊失敗也不重點。
    const handle = await control.read(() => page.evaluateHandle(locateConfirm));
    const button = handle.asElement();
    if (!button) {
        await handle.dispose().catch(() => {});
        throw fail();
    }
    try {
        control.check();
        await button.click({ timeout: options.timeoutMs ?? 5_000 });
    } catch {
        control.check();
        throw fail();
    } finally {
        await button.dispose().catch(() => {});
    }

    // 等待彈窗消失，再觀察一小段時間確認沒有重現。
    const interval = options.pollIntervalMs ?? 50;
    const deadline = performance.now() + (options.timeoutMs ?? 5_000);
    let goneAt: number | undefined;
    while (performance.now() < deadline) {
        const state = await read();
        if (state === "other") throw fail();
        if (state === "notice" && goneAt !== undefined) throw fail();
        if (state === "none") {
            goneAt ??= performance.now();
            if (performance.now() - goneAt >= (options.settleMs ?? 300)) return "dismissed";
        }
        await pause(Math.min(interval, deadline - performance.now()));
    }
    throw fail();
}
