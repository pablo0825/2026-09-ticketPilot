import type { BrowserContext } from "playwright";
import type { PurchaseLease } from "../storage/purchaseLock.js";
import type { WorkerPurchaseEvent } from "../shared/runEvents.js";

export interface WorkerInput<S> {
    activity: S;
    lease: PurchaseLease;
}

import type { WorkerResult } from "./workerReports.js";
export type { WorkerResult } from "./workerReports.js";

export interface WorkerEnvironment {
    onBrowser(context: BrowserContext): void;
    sendEvent(event: WorkerPurchaseEvent): void;
    // 必須在嘗試提交之前同步呼叫；不能排入背景工作或等點擊成功才回報。
    onSubmitAttempt(): void;
    signal?: AbortSignal;
    waitForParticipants?: (confirmationId: string) => Promise<void>;
}

export interface WorkerEntry {
    id: string;
    // 平台必須驗證 lease；流程與瀏覽器皆結束才釋放，外層不另行釋放。
    run(input: WorkerInput<unknown>, environment: WorkerEnvironment): Promise<WorkerResult>;
}

export function createWorkerEntry<S extends { platform: string }>(
    id: S["platform"],
    parse: (value: unknown) => S,
    run: (input: WorkerInput<S>, environment: WorkerEnvironment) => Promise<WorkerResult>,
): WorkerEntry {
    return {
        id,
        run(input, environment) {
            const activity = parse(input.activity);
            if (activity.platform !== id) throw new Error("購票程序與活動平台不符。");

            return run({ activity, lease: input.lease }, environment);
        },
    };
}

export function createWorkerRegistry(entries: readonly WorkerEntry[]) {
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("購票程序重複登記。");

    return (platform: string): WorkerEntry => {
        const entry = entries.find(item => item.id === platform);
        if (!entry) throw new Error("不支援的購票程序。");

        return entry;
    };
}

export function isStopMessage(value: unknown, type: string | undefined): boolean {
    return (
        type !== undefined &&
        !!value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === type &&
        Object.keys(value).length === 1
    );
}
