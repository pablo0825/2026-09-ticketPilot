import type { PurchaseSnapshot } from "../../shared/runSnapshot.js";
import type { PurchaseEvent } from "../../shared/runEvents.js";

export type PlatformSnapshotFields = Pick<PurchaseSnapshot, "activityName" | "saleAt" | "flowType">;
export type PlatformOutcome = "information-ready" | "payment-ready" | "registration-ready";

export interface BoundRunRules {
    fingerprintVersion: number;
    comparableVersions: readonly number[];
    settingsContent(version: number | undefined): unknown | undefined;
    requestContent(version: number | undefined): unknown | undefined;
    snapshotFields: PlatformSnapshotFields;
    validateStart(): void;
    validateSchedule(now: number): void;
}

export interface PlatformDefinition<E extends { type: string } = PurchaseEvent> {
    id: string;
    name: string;
    recordVersions: readonly number[];
    stop?: { message: { type: string } };
    participants?: {
        messageType: string;
        pending(events: { event: E }[]): string | undefined;
        message(confirmationId: string): { type: string; confirmationId: string };
    };
    bind(settings: unknown): BoundRunRules;
    parseEvent(value: unknown): E | undefined;
    waitingForSale(events: { event: E }[]): boolean;
    acceptsResult(value: unknown): value is PlatformOutcome;
    stopReason(value: unknown): value is "user-stop" | "time-limit";
}

// 共用層逐欄取值，不展開平台物件，避免覆寫識別碼與執行控制欄位。
export function runSnapshotFields(fields: PlatformSnapshotFields): PlatformSnapshotFields {
    return {
        activityName: fields.activityName,
        ...(fields.saleAt ? { saleAt: fields.saleAt } : {}),
        ...(fields.flowType ? { flowType: fields.flowType } : {}),
    };
}

export function createExecutionRegistry<E extends { type: string }>(entries: readonly PlatformDefinition<E>[]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("平台執行規則重複登記。");
    return (id: string | null): PlatformDefinition<E> => {
        const entry = entries.find(item => item.id === id);
        if (!entry) throw new Error("不支援的執行平台。");
        return entry;
    };
}
