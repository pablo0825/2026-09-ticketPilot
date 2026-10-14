import { z } from "zod";
import type { RunEvent } from "../core/logger.js";

// 平台專用進度留在本機執行層，不改 Klook 的狀態機或模擬事件。
export const ticketPlusEventSchema = z.discriminatedUnion("stage", [
    z
        .object({
            type: z.literal("ticketplus"),
            stage: z.literal("login-ready"),
            confirmationId: z.string().uuid(),
        })
        .strict(),
    z
        .object({
            type: z.literal("ticketplus"),
            stage: z.enum([
                "starting",
                "waiting-for-login",
                "selecting-session",
                "selecting-tickets",
                "submitting",
                "queue",
            ]),
        })
        .strict(),
]);
export type TicketPlusWorkerEvent = z.infer<typeof ticketPlusEventSchema>;
export type PurchaseEvent = RunEvent | TicketPlusWorkerEvent;
