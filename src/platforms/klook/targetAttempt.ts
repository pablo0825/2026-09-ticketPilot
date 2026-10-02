import type { PurchaseTarget } from "../../core/types.js";
import type { TargetAttempt, AttemptResult } from "../../core/priorityStrategy.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { reportState } from "../../core/state.js";
import type { Page } from "playwright";
import { KlookTicketSelector } from "./ticketSelector.js";
import { KlookSeatSelector, type AssignedSeat } from "./seatSelector.js";

export interface KlookAssignment {
    seatSelector: KlookSeatSelector;
    seats: AssignedSeat[];
}

export class KlookTargetAttempt implements TargetAttempt<KlookAssignment> {
    constructor(private readonly page: Page) {}

    async attempt(target: PurchaseTarget): Promise<AttemptResult<KlookAssignment>> {
        reportState("TICKET_SELECTION");
        await new KlookTicketSelector(this.page).selectAndVerify(target);
        reportState("SELECTION_VERIFIED");
        reportState("SEAT_ASSIGNMENT");
        const seatSelector = new KlookSeatSelector(this.page);
        const seats = await seatSelector.openAndVerify(target);
        return { status: "matched", value: { seatSelector, seats } };
    }

    async returnAfterFailure(): Promise<void> {
        // 尚無真實失敗彈窗及返回證據；不可使用測試 fixture 的 selector 點擊實站。
        throw new PurchaseStop("Klook 無票彈窗自動返回尚未啟用。");
    }
}
