import type { TicketPlusWorkerEvent } from "../app/platforms/ticketPlusEvents.js";

export type WorkerPurchaseEvent = { type: "log"; message: string } | TicketPlusWorkerEvent;

// 只供既有執行紀錄讀取與顯示；新 worker 不再產生舊狀態、順位或恢復事件。
type HistoricalRunEvent =
    | { type: "state"; state: string }
    | { type: "target"; index: number; total: number; area: string; quantity: number; date: string; time: string }
    | { type: "recovery"; queue: number; reservation: number };
export type PurchaseEvent = WorkerPurchaseEvent | HistoricalRunEvent;
