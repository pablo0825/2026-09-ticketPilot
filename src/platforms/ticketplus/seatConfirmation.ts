import type { Page } from "playwright";
import type { TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { InformationPage } from "./informationPage.js";
import { readTicketPlusPage } from "./pageState.js";
import type { TicketPlusPage } from "./pageState.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl } from "./runControl.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type SeatConfirmationReason = "seat-mismatch" | "seat-confirm-unconfirmed" | "time-limit" | "user-stopped";
export type SeatConfirmationResult =
    | { outcome: "confirmed"; information: InformationPage }
    | { outcome: "stopped" | "unknown"; reason: SeatConfirmationReason };

export interface SeatConfirmationOptions {
    // 點擊後等待資料頁的上限；也作為點擊前讀取的上限。
    timeoutMs?: number;
    clickTimeoutMs?: number;
    pollIntervalMs?: number;
}

function sameSession(page: TicketPlusPage, session: VerifiedTicketPlusSession): boolean {
    return (
        "eventId" in page &&
        page.eventId === session.eventId &&
        "sessionId" in page &&
        page.sessionId === session.sessionId
    );
}

// 座位列數等於設定張數，每列票區與設定票區完全相同；位置只要求有值，不比對排號。
function seatsMatch(page: TicketPlusPage, settings: TicketPlusSelection): boolean {
    if (page.kind !== "seat-confirmation" || !page.nextEnabled) return false;
    return (
        page.seats.length === settings.target.quantity &&
        page.seats.every(seat => seat.area === settings.target.ticketType && seat.position !== "")
    );
}

// 核對確認選位結果後按一次下一步，抵達同場次資料頁才算完成；不按取消購票、不重按。
export async function confirmTicketPlusSeats(
    page: Page,
    settings: TicketPlusSelection,
    session: VerifiedTicketPlusSession,
    control: TicketPlusRunControl,
    options: SeatConfirmationOptions = {},
): Promise<SeatConfirmationResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const stopped = (error: TicketPlusStopError, clicked: boolean): SeatConfirmationResult =>
        clicked
            ? { outcome: "unknown", reason: "seat-confirm-unconfirmed" }
            : { outcome: "stopped", reason: error.stopReason === "time-limit" ? "time-limit" : "user-stopped" };
    let clicked = false;
    try {
        // 點擊前核對同場次的選位結果與設定相符。
        control.check();
        const before = await control.read(() => readTicketPlusPage(page));
        if (!sameSession(before, session) || !seatsMatch(before, settings)) {
            return { outcome: "stopped", reason: "seat-mismatch" };
        }

        // 唯一可見的下一步只按一次；點擊錯誤也視為已嘗試。
        const button = page.getByRole("button", { name: "下一步", exact: true }).filter({ visible: true });
        if ((await control.read(() => button.count())) !== 1) return { outcome: "stopped", reason: "seat-mismatch" };
        control.check();
        clicked = true;
        try {
            await button.click({ timeout: options.clickTimeoutMs ?? 5_000 });
        } catch {
            control.check();
            return { outcome: "unknown", reason: "seat-confirm-unconfirmed" };
        }

        // 等待同場次資料頁；期限內沒到就回報未確認，不重按。
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            const after = await control.read(() => readTicketPlusPage(page)).catch(() => undefined);
            if (after?.kind === "information" && sameSession(after, session)) {
                return { outcome: "confirmed", information: after };
            }
            await control.wait(Math.max(1, Math.min(options.pollIntervalMs ?? 100, deadline - performance.now())));
        }
        return { outcome: "unknown", reason: "seat-confirm-unconfirmed" };
    } catch (error) {
        if (error instanceof TicketPlusStopError) return stopped(error, clicked);
        if (clicked) return { outcome: "unknown", reason: "seat-confirm-unconfirmed" };
        throw error;
    }
}
