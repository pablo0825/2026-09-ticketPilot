import { releasePurchaseLease, type PurchaseLease } from "../../../src/storage/purchaseLock.js";

// 透過真正的 IPC 傳入新舊事件，驗證即時 worker 與歷史讀檔使用不同的接受範圍。
process.once("message", (input: { lease: PurchaseLease }) => {
    for (const event of [
        { type: "log", message: "新的文字紀錄" },
        { type: "ticketplus", stage: "selecting-tickets" },
        { type: "state", state: "PAYMENT_READY" },
        { type: "target", index: 1, total: 1, area: "A區", quantity: 1, date: "2026-11-02", time: "19:30" },
        { type: "recovery", queue: 1, reservation: 0 },
        { type: "log", message: 123 },
        { type: "ticketplus", stage: "unknown-stage" },
        { type: "log", message: "事件傳送完成" },
    ]) {
        process.send?.({ type: "event", event });
    }
    process.send?.({ type: "result", outcome: "failed", message: "測試完成" });
    releasePurchaseLease(input.lease);
    process.send?.({ type: "finished" }, () => process.disconnect?.());
});
