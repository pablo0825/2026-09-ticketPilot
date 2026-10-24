import { releasePurchaseLease, type PurchaseLease } from "../../../src/storage/purchaseLock.js";

// 不開瀏覽器：送出指定階段事件與結果，用來測試主服務如何接收 TicketPlus 新結果。
process.once("message", (input: { lease: PurchaseLease }) => {
    const stage = process.env.FIXTURE_STAGE;
    const confirmationId = process.env.FIXTURE_CONFIRMATION;
    if (stage) {
        process.send?.({
            type: "event",
            event: { type: "ticketplus", stage, ...(confirmationId ? { confirmationId } : {}) },
        });
    }
    const stopReason = process.env.FIXTURE_STOP_REASON;
    process.send?.({
        type: "result",
        outcome: process.env.FIXTURE_OUTCOME,
        message: "fixture 結果",
        ...(stopReason ? { stopReason } : {}),
    });
    releasePurchaseLease(input.lease);
    process.send?.({ type: "finished" }, () => process.disconnect?.());
});
