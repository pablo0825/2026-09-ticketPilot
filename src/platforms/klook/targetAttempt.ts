import { PurchaseStop } from "../../core/purchaseStop.js";
import { hasVisibleSeatScreen } from "./eventPage.js";
import type { PurchaseTarget } from "../../core/types.js";
import type { TargetAttempt, AttemptResult } from "../../core/priorityStrategy.js";
import { KlookSelectionFailure, SelectionFailure } from "./selectionFailure.js";
import { reportState } from "../../core/state.js";
import type { Page } from "playwright";
import { KlookTicketSelector } from "./ticketSelector.js";
import { KlookSeatSelector } from "./seatSelector.js";
import type { Allocation } from "./allocation.js";

export interface KlookAssignment {
    seatSelector: KlookSeatSelector;
    allocation: Allocation;
}

export class KlookTargetAttempt implements TargetAttempt<KlookAssignment> {
    private readonly failure: KlookSelectionFailure;

    constructor(
        private readonly page: Page,
        eventUrl: string,
        private readonly timeout = 30_000,
    ) {
        this.failure = new KlookSelectionFailure(page, eventUrl, timeout);
    }

    async attempt(target: PurchaseTarget): Promise<AttemptResult<KlookAssignment>> {
        await this.failure.assertNoExistingNotice();
        reportState("TICKET_SELECTION");
        const selection = await new KlookTicketSelector(this.page, this.timeout, () =>
            this.failure.assertNoExistingNotice(),
        ).selectAndVerify(target, target.expectation.unitPrice);
        if (selection === "disabled") {
            // 跳過前再次確認頁面；有過期或未知提示時，不將本次觀察當成可換順位。
            await this.failure.assertNoExistingNotice();
            if (await hasVisibleSeatScreen(this.page)) {
                throw new PurchaseStop("目標停用但已有選位畫面，已停止；不換順位。");
            }
            return { status: "unavailable", reason: "disabled" };
        }
        reportState("SELECTION_VERIFIED");
        reportState("SEAT_ASSIGNMENT");
        const seatSelector = new KlookSeatSelector(this.page, target.expectation.unitPrice, this.timeout);
        await this.failure.assertNoExistingNotice();
        try {
            const allocation = await seatSelector.openAndVerify(target, () => this.failure.observe());
            return { status: "matched", value: { seatSelector, allocation } };
        } catch (error) {
            if (error instanceof SelectionFailure) return { status: "unavailable", reason: error.reason };
            throw error;
        }
    }

    async returnAfterFailure(): Promise<void> {
        await this.failure.returnAfterFailure();
    }
}
