import type { PurchaseEvent } from "../../../shared/runEvents.js";
import { createPresenterRegistry } from "./runPresenterDefinition.js";
import { ticketPlusPresenter } from "./ticketplus/runPresentation.js";

// 純呈現函式不載入工作區元件，避免 Workspace → RunStatus → Workspace。
const presenters = [ticketPlusPresenter];
export const presenterFor = createPresenterRegistry(presenters);
export function platformEventMessage(event: PurchaseEvent, platform?: string | null): string | undefined {
    if (platform !== undefined) return presenterFor(platform)?.eventMessage(event);
    // 舊的純紀錄呼叫沒有快照平台，保留按事件辨識的相容入口。
    for (const presenter of presenters) {
        const message = presenter.eventMessage(event);
        if (message !== undefined) return message;
    }
    return undefined;
}
