import { z } from "zod";

// 目前 worker 只回報 TicketPlus 階段與文字紀錄。
export const ticketPlusEventSchema = z.discriminatedUnion("stage", [
    z
        .object({
            type: z.literal("ticketplus"),
            stage: z.literal("login-ready"),
            confirmationId: z.string().uuid(),
        })
        .strict(),
    // 抽選等待使用者在 GUI 確認參加者已填完；確認 ID 只用於本輪轉送。
    z
        .object({
            type: z.literal("ticketplus"),
            stage: z.literal("waiting-for-participants"),
            confirmationId: z.string().uuid(),
        })
        .strict(),
    z
        .object({
            type: z.literal("ticketplus"),
            stage: z.enum([
                "starting",
                "checking-login",
                "opening-activity",
                "waiting-for-login",
                "waiting-for-sale",
                "refreshing-activity",
                "waiting-for-availability",
                "selecting-session",
                "selecting-tickets",
                "submitting",
                "queue",
                "waiting-to-refresh",
                "refreshing",
                "submitting-information",
                "completing-registration",
            ]),
        })
        .strict(),
]);
export type TicketPlusWorkerEvent = z.infer<typeof ticketPlusEventSchema>;
export type WorkerPurchaseEvent = { type: "log"; message: string } | TicketPlusWorkerEvent;

// 只供既有執行紀錄讀取與顯示；新 worker 不再產生舊狀態、順位或恢復事件。
type HistoricalRunEvent =
    | { type: "state"; state: string }
    | { type: "target"; index: number; total: number; area: string; quantity: number; date: string; time: string }
    | { type: "recovery"; queue: number; reservation: number };
export type PurchaseEvent = WorkerPurchaseEvent | HistoricalRunEvent;
