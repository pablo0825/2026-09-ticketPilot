import { z } from "zod";
import { executionPlatform } from "../app/platforms/index.js";
import { platformIds } from "../config/platforms.js";
import type { PurchaseSnapshot } from "../shared/runSnapshot.js";

export interface RunRecord {
    snapshot: PurchaseSnapshot;
    fingerprint: string;
    fingerprintVersion?: number;
    activity?: { id: string; settingsHash: string };
}

// 歷史紀錄保留原接受範圍與未知欄位；不能套用新 worker 的嚴格訊息格式。
export function parseRunRecord(value: unknown, id: string): RunRecord | "archived-klook" {
    const record = value as RunRecord;
    const valid = z
        .object({
            fingerprintVersion: z.number().int().optional(),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
            activity: z
                .object({ id: z.string().uuid(), settingsHash: z.string().regex(/^[0-9a-f]{64}$/) })
                .strict()
                .optional(),
            snapshot: z.object({
                platform: z.enum(["klook", ...platformIds]).optional(),
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
                            event: z.unknown(),
                        }),
                    )
                    .max(300),
            }),
        })
        .safeParse(record);
    if (!valid.success) throw new Error("Invalid run record");
    const platform = valid.data.snapshot.platform ?? "klook";
    const legacyEvent = z.object({ type: z.enum(["state", "log", "target", "recovery"]) }).passthrough();
    const definition = platform === "klook" ? undefined : executionPlatform(platform);
    const versions = definition?.recordVersions ?? [2, 3, 4];
    if (record.fingerprintVersion !== undefined && !versions.includes(record.fingerprintVersion))
        throw new Error("Invalid fingerprint platform");
    for (const item of valid.data.snapshot.events) {
        if (!legacyEvent.safeParse(item.event).success && !definition?.parseEvent(item.event))
            throw new Error("Invalid platform event");
    }
    if (
        !definition &&
        (valid.data.snapshot.status === "information-ready" ||
            valid.data.snapshot.status === "registration-ready" ||
            valid.data.snapshot.flowType !== undefined ||
            valid.data.snapshot.stopReason !== undefined)
    )
        throw new Error("Invalid platform result");
    if (platform === "klook") return "archived-klook";
    const snapshot = { ...record.snapshot, platform };
    delete snapshot.canStop;
    delete snapshot.stopRequest;
    delete snapshot.loginConfirmation;
    delete snapshot.participantConfirmation;
    delete snapshot.canCloseBrowser;
    return { ...record, snapshot };
}
