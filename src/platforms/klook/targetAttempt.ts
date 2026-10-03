import type { PurchaseTarget } from "../../core/types.js";
import type { TargetAttempt, AttemptResult } from "../../core/priorityStrategy.js";
import { KlookSelectionFailure, SelectionFailure } from "./selectionFailure.js";
import { reportState } from "../../core/state.js";
import type { Page } from "playwright";
import { KlookTicketSelector } from "./ticketSelector.js";
import { KlookSeatSelector, type AssignedSeat } from "./seatSelector.js";

export interface KlookAssignment {
    seatSelector: KlookSeatSelector;
    seats: AssignedSeat[];
}

export class KlookTargetAttempt implements TargetAttempt<KlookAssignment> {
    private readonly failure: KlookSelectionFailure;

    constructor(private readonly page: Page, eventUrl: string, private readonly timeout = 30_000) {
        this.failure = new KlookSelectionFailure(page, eventUrl, timeout);
    }

    async attempt(target: PurchaseTarget): Promise<AttemptResult<KlookAssignment>> {
        await this.failure.assertNoExistingNotice();
        reportState("TICKET_SELECTION");
        await new KlookTicketSelector(this.page, this.timeout).selectAndVerify(target, target.expectation.unitPrice);
        reportState("SELECTION_VERIFIED");
        reportState("SEAT_ASSIGNMENT");
        const seatSelector = new KlookSeatSelector(this.page, target.expectation.unitPrice, this.timeout);
        await this.failure.assertNoExistingNotice();
        try {
            const seats = await seatSelector.openAndVerify(target, () => this.failure.observe());
            return { status: "matched", value: { seatSelector, seats } };
        } catch (error) {
            if (error instanceof SelectionFailure) return { status: "unavailable", reason: error.reason };
            throw error;
        }
    }

    async returnAfterFailure(): Promise<void> {
        await this.failure.returnAfterFailure();
    }
}
