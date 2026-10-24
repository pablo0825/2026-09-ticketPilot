import { z } from "zod";
import { ticketPlusEventSchema } from "../app/platforms/ticketPlusEvents.js";
import type { PurchaseSnapshot } from "../shared/runSnapshot.js";

export interface RunRecord {
    snapshot: PurchaseSnapshot;
    fingerprint: string;
    fingerprintVersion?: 2 | 3 | 4 | 5;
    activity?: { id: string; settingsHash: string };
}

// 歷史紀錄保留原接受範圍與未知欄位；不能套用新 worker 的嚴格訊息格式。
export function parseRunRecord(value: unknown, id: string): RunRecord | "archived-klook" {
    const record = value as RunRecord;
    const valid = z
        .object({
            fingerprintVersion: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            activity: z
                .object({ id: z.string().uuid(), settingsHash: z.string().regex(/^[0-9a-f]{64}$/) })
                .strict()
                .optional(),
            snapshot: z.object({
                platform: z.enum(["klook", "ticketplus"]).optional(),
                id: z.string(),
                requestId: z.literal(id),
                activityName: z.string(),
                saleAt: z.string().optional(),
                flowType: z.enum(["purchase", "lottery"]).optional(),
                stopReason: z.enum(["user-stop", "time-limit"]).optional(),
                status: z.enum([
                    "running",
                    "payment-ready",
                    "information-ready",
                    "registration-ready",
                    "failed",
                    "unknown",
                    "interrupted",
                ]),
                browserOpen: z.boolean(),
                occupied: z.boolean(),
                message: z.string(),
                historyTruncated: z.boolean(),
                events: z
                    .array(
                        z.object({
                            sequence: z.number().int(),
                            at: z.string(),
                            event: z.union([
                                z.object({ type: z.enum(["state", "log", "target", "recovery"]) }).passthrough(),
                                ticketPlusEventSchema,
                            ]),
                        }),
                    )
                    .max(300),
            }),
        })
        .safeParse(record);
    if (!valid.success) throw new Error("Invalid run record");
    const platform = valid.data.snapshot.platform ?? "klook";
    if (record.fingerprintVersion === 5 && platform !== "ticketplus") {
        throw new Error("Invalid fingerprint platform");
    }
    if (
        platform !== "ticketplus" &&
        (valid.data.snapshot.status === "information-ready" ||
            valid.data.snapshot.status === "registration-ready" ||
            valid.data.snapshot.flowType !== undefined ||
            valid.data.snapshot.stopReason !== undefined ||
            valid.data.snapshot.events.some(item => item.event.type === "ticketplus"))
    ) {
        throw new Error("Invalid platform event or result");
    }

    // 有效舊紀錄只回報封存標記。查詢請求 ID 時仍須拒絕重用，不能當成不存在。
    if (platform === "klook") return "archived-klook";
    const snapshot = { ...record.snapshot, platform: "ticketplus" as const };
    delete snapshot.canStop;
    delete snapshot.stopRequest;
    delete snapshot.loginConfirmation;
    delete snapshot.participantConfirmation;
    delete snapshot.canCloseBrowser;
    return { ...record, snapshot };
}
