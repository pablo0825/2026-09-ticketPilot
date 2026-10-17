import type { ElementHandle, Page } from "playwright";
import type { TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { InformationPage } from "./informationPage.js";
import { readTicketPlusPage } from "./pageState.js";
import type { TicketPlusPage } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type SeatConfirmationReason =
    "seat-mismatch" | "button-unavailable" | "seat-confirm-unconfirmed" | "time-limit" | "user-stopped";
export type SeatConfirmationResult =
    | { outcome: "confirmed"; information: InformationPage }
    | { outcome: "stopped" | "unknown"; reason: SeatConfirmationReason };

export interface SeatConfirmationOptions {
    // 點擊後等待資料頁的上限；仍受全程期限限制。
    timeoutMs?: number;
    clickTimeoutMs?: number;
    pollIntervalMs?: number;
}

const unconfirmed: SeatConfirmationResult = { outcome: "unknown", reason: "seat-confirm-unconfirmed" };

function sameSession(page: TicketPlusPage, session: VerifiedTicketPlusSession): boolean {
    return (
        "eventId" in page &&
        page.eventId === session.eventId &&
        "sessionId" in page &&
        page.sessionId === session.sessionId
    );
}

// 座位列數等於設定張數，每列票區與設定票區完全相同；位置只要求有值，不比對排號。
function seatsMatch(page: TicketPlusPage, settings: TicketPlusSelection, session: VerifiedTicketPlusSession): boolean {
    if (page.kind !== "seat-confirmation" || !sameSession(page, session)) return false;
    return (
        page.seats.length === settings.target.quantity &&
        page.seats.every(seat => seat.area === settings.target.ticketType && seat.position !== "")
    );
}

// 剩餘時間取設定上限與全程期限較小者；沒有全程期限時只用設定上限。
function bounded(control: TicketPlusRunControl, milliseconds: number): number {
    return Math.max(1, Math.min(milliseconds, control.remainingMs()));
}

// 固定唯一可見的「下一步」節點，點擊前以同一節點再核對頁面，避免換頁後點到別頁的同名按鈕。
async function clickNextOnce(
    page: Page,
    settings: TicketPlusSelection,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    clickTimeoutMs: number,
    markAttempt: () => void,
): Promise<"clicked" | "unavailable" | "changed"> {
    const locator = page.locator("button.nextBtn").filter({ hasText: /^\s*下一步\s*$/, visible: true });
    if ((await control.read(() => locator.count())) !== 1) return "unavailable";
    let handle: ElementHandle | null = null;
    try {
        handle = await control.read(() => locator.elementHandle({ timeout: bounded(control, clickTimeoutMs) }));
        const latest = await control.read(() => readTicketPlusPage(page));
        if (!seatsMatch(latest, settings, session)) return "changed";
        if (!(await control.read(() => handle!.isEnabled()))) return "unavailable";
        const timeout = bounded(control, clickTimeoutMs);
        markAttempt();
        await handle.click({ timeout });
        return "clicked";
    } finally {
        await handle?.dispose().catch(() => {});
    }
}

// 點擊後等待同場次資料頁；期限內沒到就回報未確認，不重按。
async function waitForInformation(
    page: Page,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: SeatConfirmationOptions,
): Promise<SeatConfirmationResult> {
    const deadline = performance.now() + bounded(control, options.timeoutMs ?? 15_000);
    while (performance.now() < deadline) {
        const after = await control.read(() => readTicketPlusPage(page)).catch(() => undefined);
        if (after?.kind === "information" && sameSession(after, session)) {
            return { outcome: "confirmed", information: after };
        }
        await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 100, deadline - performance.now())));
    }
    return unconfirmed;
}

// 核對確認選位結果後按一次下一步，抵達同場次資料頁才算完成；不按取消購票、不重按。
export async function confirmTicketPlusSeats(
    page: Page,
    settings: TicketPlusSelection,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: SeatConfirmationOptions = {},
): Promise<SeatConfirmationResult> {
    let clicked = false;
    try {
        // 點擊前核對同場次的選位結果與設定相符。
        control.check();
        const before = await control.read(() => readTicketPlusPage(page));
        if (!seatsMatch(before, settings, session)) return { outcome: "stopped", reason: "seat-mismatch" };
        if (before.kind !== "seat-confirmation" || !before.nextEnabled) {
            return { outcome: "stopped", reason: "button-unavailable" };
        }

        // 只按一次下一步；點擊開始後任何錯誤都視為已嘗試，點擊前的錯誤照常停止。
        const click = await clickNextOnce(page, settings, session, control, options.clickTimeoutMs ?? 5_000, () => {
            clicked = true;
        }).catch(error => {
            if (error instanceof TicketPlusStopError || !clicked) throw error;
            return "failed" as const;
        });
        if (click === "unavailable") return { outcome: "stopped", reason: "button-unavailable" };
        if (click === "changed") return { outcome: "stopped", reason: "seat-mismatch" };
        if (click === "failed") return unconfirmed;

        // 抵達同場次資料頁才完成。
        return await waitForInformation(page, session, control, options);
    } catch (error) {
        if (!(error instanceof TicketPlusStopError)) {
            if (clicked) return unconfirmed;
            throw error;
        }
        return clicked
            ? unconfirmed
            : { outcome: "stopped", reason: error.stopReason === "time-limit" ? "time-limit" : "user-stopped" };
    }
}
