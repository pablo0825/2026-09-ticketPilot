import { purchaseStatus } from "./runStatus.js";
import { ticketPlusStepsView } from "./ticketPlusSteps.js";
import type { RunPresenter } from "../runPresenterDefinition.js";

export const ticketPlusPresenter: RunPresenter = {
    id: "ticketplus",
    name: "TicketPlus",
    status: purchaseStatus,
    steps: ticketPlusStepsView,
    eventMessage: event => (event.type === "ticketplus" ? `TicketPlus 階段：${event.stage}` : undefined),
};
