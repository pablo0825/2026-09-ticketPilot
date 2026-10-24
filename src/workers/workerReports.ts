import { z } from "zod";
import type { PlatformDefinition } from "../app/platforms/platformDefinition.js";
import type { PurchaseEvent } from "../shared/runEvents.js";

const resultSchema = z
    .object({
        type: z.literal("result"),
        outcome: z.enum(["information-ready", "payment-ready", "registration-ready", "failed", "unknown"]),
        message: z.string(),
        stopReason: z.unknown().optional(),
    })
    .strict();
export type WorkerResult = Omit<z.infer<typeof resultSchema>, "type" | "stopReason"> & {
    stopReason?: "user-stop" | "time-limit";
};
export type WorkerReport =
    | { type: "event"; event: PurchaseEvent }
    | ({ type: "result" } & WorkerResult)
    | { type: "browser"; open: boolean }
    | { type: "finished" }
    | { type: "close-error" };

const eventSchema = z.object({ type: z.literal("event"), event: z.unknown() }).strict();
const logSchema = z.object({ type: z.literal("log"), message: z.string() }).strict();
const browserSchema = z.object({ type: z.literal("browser"), open: z.boolean() }).strict();
const finishedSchema = z.object({ type: z.literal("finished") }).strict();
const closeErrorSchema = z.object({ type: z.literal("close-error") }).strict();

// 新回報先驗證才交給執行管理；歷史紀錄仍使用自己的相容解析器。
// 舊事件與未知訊息沿用忽略規則；結果與生命週期格式錯誤則停止 worker。
export function parseWorkerReport(value: unknown, platform: PlatformDefinition): WorkerReport | undefined {
    if (!value || typeof value !== "object" || !("type" in value)) return undefined;
    switch (value.type) {
        case "event": {
            const envelope = eventSchema.safeParse(value);
            if (!envelope.success) return undefined;
            const log = logSchema.safeParse(envelope.data.event);
            const event = log.success ? log.data : platform.parseEvent(envelope.data.event);
            return event ? { type: "event", event } : undefined;
        }
        case "result": {
            const result = resultSchema.parse(value);
            if (
                result.outcome !== "failed" &&
                result.outcome !== "unknown" &&
                !platform.acceptsResult(result.outcome)
            ) {
                throw new Error("購票程序回報了不支援的結果。");
            }
            // 沿用既有相容行為：未知停止原因不寫入紀錄，也不取得操作資格。
            return {
                type: "result",
                outcome: result.outcome,
                message: result.message,
                ...(platform.stopReason(result.stopReason) ? { stopReason: result.stopReason } : {}),
            };
        }
        case "browser":
            return browserSchema.parse(value);
        case "finished":
            return finishedSchema.parse(value);
        case "close-error":
            return closeErrorSchema.parse(value);
        default:
            return undefined;
    }
}
