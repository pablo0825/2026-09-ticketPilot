import type { TicketSelectionPage } from "./ticketSelectionPage.js";
import type { PageIdentity, EventDetails } from "./readResult.js";

export interface SubmittedSelectionTarget extends PageIdentity, EventDetails {
    ticketType: string;
    quantity: number;
}

export function matchesSubmittedSelection(value: TicketSelectionPage, target: SubmittedSelectionTarget): boolean {
    // 活動身分與本次提交的場次必須一致。
    if (
        value.eventId !== target.eventId ||
        value.sessionId !== target.sessionId ||
        value.eventName !== target.eventName ||
        value.date !== target.date ||
        value.time !== target.time
    ) {
        return false;
    }

    // 目標唯一且張數相符，其他票種必須保持零張。
    const matches = value.tickets.filter(ticket => ticket.name === target.ticketType);
    return (
        matches.length === 1 &&
        matches[0]!.saleStatus === "selling" &&
        matches[0]!.selectedQuantity === target.quantity &&
        value.tickets.every(ticket => ticket === matches[0] || ticket.selectedQuantity === 0)
    );
}
