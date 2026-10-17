import { releasePurchaseLease, type PurchaseLease } from "../../../src/app/purchaseLock.js";

// 不開瀏覽器：送出指定階段事件與結果，用來測試主服務如何接收 TicketPlus 新結果。
process.once("message", (input: { lease: PurchaseLease }) => {
    const stage = process.env.FIXTURE_STAGE;
    if (stage) process.send?.({ type: "event", event: { type: "ticketplus", stage } });
    process.send?.({ type: "result", outcome: process.env.FIXTURE_OUTCOME, message: "fixture 結果" });
    releasePurchaseLease(input.lease);
    process.send?.({ type: "finished" }, () => process.disconnect?.());
});
