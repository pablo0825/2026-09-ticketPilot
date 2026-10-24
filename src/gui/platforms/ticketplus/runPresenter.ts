import { ticketPlusPurchaseStatus } from "./runStatus.js";
import { ticketPlusStepsView } from "./runSteps.js";
import type { RunPresenter } from "../runPresenterDefinition.js";

export const ticketPlusPresenter: RunPresenter = {
    id: "ticketplus",
    name: "TicketPlus",
    status: ticketPlusPurchaseStatus,
    steps: ticketPlusStepsView,
    eventMessage: event => (event.type === "ticketplus" ? `TicketPlus 階段：${event.stage}` : undefined),
};
