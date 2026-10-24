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
export type { WorkerPurchaseEvent, PurchaseEvent } from "../shared/runEvents.js";
