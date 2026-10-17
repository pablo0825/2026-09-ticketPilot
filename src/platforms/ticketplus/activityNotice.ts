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

// 在唯一的已知提醒彈窗內找「確定」，並用掉本次頁面載入的關閉額度；
// 額度記在頁面 window 上，重新載入或換頁後自然重設。不符條件或額度已用回傳 null。
// 函式內只用物件方法與行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。
function claimConfirm(): Element | null {
    const view = {
        visible(element: Element): boolean {
            const style = getComputedStyle(element);
            return element.getClientRects().length > 0 && style.visibility !== "hidden" && style.display !== "none";
        },
        usable(element: Element): boolean {
            return (
                view.visible(element) &&
                !(element as HTMLButtonElement).disabled &&
                element.getAttribute("aria-disabled") !== "true"
            );
        },
    };
    const marker = window as unknown as { __ticketPilotNoticeClaimed?: boolean };
    if (marker.__ticketPilotNoticeClaimed) return null;

    // 再次核對白名單標題與兩顆按鈕，避免點到剛換上的其他彈窗。
    const dialogs = Array.from(document.querySelectorAll(".v-dialog")).filter(element => view.visible(element));
    if (dialogs.length !== 1) return null;
    const title = (dialogs[0] as HTMLElement).innerText
        .split("\n")
        .map(line => line.trim())
        .find(Boolean);
    if (title !== "實名抽選制售票提醒" && title !== "入場規定") return null;
    const buttons = Array.from(dialogs[0]!.querySelectorAll('button, [role="button"]')).filter(element =>
        view.usable(element),
    );
    const names = buttons.map(button => (button.textContent ?? "").trim()).sort();
    if (names.join("|") !== ["回到首頁", "確定"].sort().join("|")) return null;

    marker.__ticketPilotNoticeClaimed = true;
    return buttons.find(button => (button.textContent ?? "").trim() === "確定")!;
}

// 關閉活動頁已知提醒：每次頁面載入只按「確定」一次，確認消失且短時間內未重現；其他情況停止，不重點。
export async function dismissTicketPlusActivityNotice(
    page: Page,
    control: TicketPlusRunControl,
    options: ActivityNoticeOptions = {},
): Promise<"none" | "dismissed"> {
    const fail = () => new TicketPlusNoticeError("notice-dismiss-failed");
    const timeoutMs = options.timeoutMs ?? 5_000;
    const deadline = performance.now() + timeoutMs;
    const pause = (milliseconds: number) => control.wait(Math.max(1, milliseconds));

    // 每次讀取都受整體上限限制；開賣前沒有全程期限，讀取卡住也不能無限等待。
    const read = async (): Promise<NoticeState> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const dom = await control.read(() =>
                Promise.race([
                    readTicketPlusDom(page),
                    new Promise<undefined>(resolve => {
                        timer = setTimeout(() => resolve(undefined), Math.max(1, deadline - performance.now()));
                    }),
                ]),
            );
            if (!dom) throw fail();
            return noticeState(dom);
        } finally {
            clearTimeout(timer);
        }
    };

    // 先確認目前只有一個已知提醒；沒有彈窗就不動作。
    const before = await read();
    if (before === "none") return "none";
    if (before === "other") throw fail();

    // 重新核對並取得本次載入唯一的點擊額度後點一次；點擊失敗也不重點。
    const handle = await control.read(() => page.evaluateHandle(claimConfirm));
    const button = handle.asElement();
    if (!button) {
        await handle.dispose().catch(() => {});
        throw fail();
    }
    try {
        control.check();
        await button.click({ timeout: Math.max(1, deadline - performance.now()) });
    } catch {
        control.check();
        throw fail();
    } finally {
        await button.dispose().catch(() => {});
    }

    // 等待彈窗消失，再觀察一小段時間確認沒有重現。
    const interval = options.pollIntervalMs ?? 50;
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
