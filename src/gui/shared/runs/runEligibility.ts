import type { PurchaseSnapshot } from "../../../shared/runSnapshot.js";
import type { RunCapabilities } from "../../../shared/runControls.js";

export function sameRun(a: PurchaseSnapshot | null | undefined, b: PurchaseSnapshot): boolean {
    return a?.id === b.id && a.platform === b.platform;
}

export function runningWithCapability(run: PurchaseSnapshot, capability: keyof RunCapabilities): boolean {
    return run.platform !== null && run.status === "running" && run.capabilities?.[capability] === true;
}
