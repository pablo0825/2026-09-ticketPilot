import type { PurchaseSnapshot } from "../../shared/runSnapshot.js";
import type { PurchaseEvent } from "../../shared/runEvents.js";
import type { RunStatusText } from "../shared/runs/commonPresentation.js";
import type { RunStepsView } from "../shared/runs/runView.js";

export interface RunPresenter<E = PurchaseEvent> {
    id: string;
    name: string;
    status(run: PurchaseSnapshot, closing: boolean, now: number): RunStatusText;
    steps?(run: PurchaseSnapshot, closing: boolean, now: number): RunStepsView | undefined;
    eventMessage(event: E): string | undefined;
}

export function createPresenterRegistry<E>(entries: readonly RunPresenter<E>[]) {
    if (new Set(entries.map(item => item.id)).size !== entries.length) throw new Error("平台狀態呈現重複登記。");
    return (platform: string | null) => entries.find(item => item.id === platform);
}
