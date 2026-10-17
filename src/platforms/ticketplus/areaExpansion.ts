import type { Page } from "playwright";
import { readTicketPlusPage } from "./pageState.js";
import type { TicketPlusRunControl } from "./runControl.js";
import { locateAreaHeader } from "./ticketRowFinder.js";

export interface AreaExpansionOptions {
    // 點擊後等待票區展開的上限；仍受呼叫端給的 deadline 限制。
    timeoutMs?: number;
    clickTimeoutMs?: number;
    pollIntervalMs?: number;
}

// expanded：已展開且恰有一列；not-expanded：點了沒展開、找不到可點的標題或期限到；
// ambiguous：展開後區內有多種票；unexpected-page：等待中出現排隊、彈窗等其他畫面。
export type AreaExpansionResult = "expanded" | "not-expanded" | "ambiguous" | "unexpected-page";

// 讀取或點擊超過 deadline 就放棄，不在期限後才開始動作。
async function beforeDeadline<T>(deadline: number, operation: Promise<T>): Promise<T | undefined> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<undefined>(resolve => {
                timer = setTimeout(() => resolve(undefined), remaining);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// 展開目標票區：只點「唯一且收合中」的目標標題一次，等到該票區展開且恰有一列票種。
// 沒有展開成功時不重點、不改點其他票區，由呼叫端依結果停止。
export async function expandTicketPlusArea(
    page: Page,
    areaName: string,
    deadline: number,
    control: TicketPlusRunControl,
    options: AreaExpansionOptions = {},
): Promise<AreaExpansionResult> {
    // 找到唯一且收合中的目標標題；已展開或找不到都不點。期限後才拿到的 handle 也要釋放。
    control.check();
    const locating = control.read(() => page.evaluateHandle(locateAreaHeader, areaName));
    const located = await beforeDeadline(deadline, locating);
    if (!located) {
        void locating.then(handle => handle.dispose()).catch(() => {});
        return "not-expanded";
    }
    const header = located.asElement();
    if (!header) {
        await located.dispose().catch(() => {});
        return "not-expanded";
    }

    // 點擊一次；點擊拋錯也不重點。
    try {
        const timeout = Math.min(options.clickTimeoutMs ?? 3_000, deadline - performance.now());
        if (timeout <= 0) return "not-expanded";
        control.check();
        await header.click({ timeout });
    } catch {
        control.check();
        return "not-expanded";
    } finally {
        await header.dispose().catch(() => {});
    }

    // 等待票區展開並出現唯一的票種列；資料暫缺（例如內容還沒畫出）可再讀。
    const waitUntil = Math.min(deadline, performance.now() + (options.timeoutMs ?? 3_000));
    while (performance.now() < waitUntil) {
        const snapshot = await beforeDeadline(
            waitUntil,
            control.read(() => readTicketPlusPage(page)),
        );
        if (!snapshot) return "not-expanded";
        if (snapshot.kind === "ticket-selection") {
            const area = snapshot.areas.find(value => value.name === areaName);
            const rows = snapshot.tickets.filter(ticket => ticket.area === areaName);
            if (area?.expanded && rows.length === 1) return "expanded";
        } else if (snapshot.kind === "unknown" && snapshot.reason === "ambiguous-data") {
            return "ambiguous";
        } else if (snapshot.kind !== "unknown" || snapshot.reason !== "incomplete-data") {
            return "unexpected-page";
        }
        await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 50, waitUntil - performance.now())));
    }
    return "not-expanded";
}
