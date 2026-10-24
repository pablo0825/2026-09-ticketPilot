import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";
import { presenterFor, platformEventMessage } from "../../platforms/runPresenterRegistry.js";
import { finishedStatus, stateRunningStatus } from "./commonPresentation.js";
export { stopRequestPresentation } from "./commonPresentation.js";
export type { StopRequestStatus } from "./commonPresentation.js";
export { latestTicketPlusStage } from "../../platforms/ticketplus/runStatus.js";

export function purchaseStatus(run: PurchaseSnapshot, closingBrowser: boolean, now: number) {
    const presenter = presenterFor(run.platform);
    return presenter
        ? presenter.status(run, closingBrowser, now)
        : run.status !== "running"
          ? finishedStatus(run, closingBrowser)
          : stateRunningStatus(run, now);
}

export function eventLogs(events: PurchaseSnapshot["events"], truncated: boolean, platform?: string | null): string {
    const lines = events.flatMap(item => {
        const event = item.event;
        let message: string;
        if (event.type === "log") message = event.message;
        else if (event.type === "target") {
            message = `嘗試順位 ${event.index}/${event.total}：${event.date} ${event.time}／${event.area}／${event.quantity} 張`;
        } else if (event.type === "recovery") message = `恢復額度：排隊 ${event.queue}/1；預留 ${event.reservation}/1`;
        else {
            const text = platformEventMessage(event, platform);
            if (text === undefined) return [];
            message = text;
        }
        return [new Date(item.at).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" }) + "  " + message];
    });
    return (truncated ? "較早紀錄已省略。\n" : "") + lines.join("\n");
}
