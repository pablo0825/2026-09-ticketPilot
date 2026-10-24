import {
    parseTicketPlusActivity,
    singleTicketPlusSelection,
    ticketPlusSessionSelection,
    validateTicketPlusRunSettings,
} from "../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings } from "../../config/ticketPlusActivity.js";
import type { PurchaseEvent } from "../../shared/runEvents.js";

// 保留原始序列化順序；明寫 purchase 與省略流程類型共用同一指紋。
export function ticketPlusFingerprintSettings(settings: TicketPlusActivitySettings) {
    const parsed = parseTicketPlusActivity(settings);
    if (parsed.flowType !== "purchase") return parsed;
    const { flowType: _purchase, ...withoutDefault } = parsed;
    return withoutDefault;
}

export function ticketPlusLegacySettings(settings: TicketPlusActivitySettings) {
    if (
        settings.targets.length !== 1 ||
        settings.flowType === "lottery" ||
        settings.saleSchedule ||
        settings.maxRunMinutes !== undefined
    )
        return undefined;
    return singleTicketPlusSelection(settings);
}

export function validateTicketPlusStart(settings: TicketPlusActivitySettings): void {
    ticketPlusSessionSelection(settings);
    validateTicketPlusRunSettings(settings);
}

export function ticketPlusWaitingForSale(events: { event: PurchaseEvent }[]): boolean {
    const event = events.filter(item => item.event.type === "ticketplus").at(-1)?.event;
    return (
        event?.type === "ticketplus" &&
        ["waiting-for-sale", "refreshing-activity", "waiting-for-availability"].includes(event.stage)
    );
}

export function ticketPlusAcceptsResult(
    value: unknown,
): value is "information-ready" | "payment-ready" | "registration-ready" {
    return value === "information-ready" || value === "payment-ready" || value === "registration-ready";
}

export function ticketPlusStopReason(value: unknown): value is "user-stop" | "time-limit" {
    return value === "user-stop" || value === "time-limit";
}
