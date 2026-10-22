import { z } from "zod";
import type { RunEvent } from "../core/logger.js";

// 平台專用進度留在本機執行層，不改 Klook 的狀態機。
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
export type PurchaseEvent = RunEvent | TicketPlusWorkerEvent;
