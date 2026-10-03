import { AsyncLocalStorage } from "node:async_hooks";
import type { PurchaseState } from "./state.js";

export type RunEvent = { type: "state"; state: PurchaseState } | { type: "log"; message: string };
const output = new AsyncLocalStorage<(event: RunEvent) => void>();

// 每次執行有自己的出口；UI 斷線或 listener 出錯不能觸發購票恢復。
export function emitRunEvent(event: RunEvent): void {
    try { void Promise.resolve(output.getStore()?.(event)).catch(() => {}); } catch { /* 觀察者不能改變購票結果。 */ }
}

export function withRunEvents<T>(listener: (event: RunEvent) => void, action: () => Promise<T>): Promise<T> {
    return output.run(listener, action);
}

export function log(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
    emitRunEvent({ type: "log", message });
}
