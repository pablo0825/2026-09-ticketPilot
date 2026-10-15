import type { TicketPlusDom } from "./domSnapshot.js";

export type UnknownReason =
    | "blocking-dialog"
    | "unsupported-url"
    | "page-changed"
    | "read-failed"
    | "conflicting-page"
    | "selection-transition"
    | "incomplete-data"
    | "ambiguous-data";
export interface UnknownPage {
    kind: "unknown";
    reason: UnknownReason;
}
export const unknownPage = (reason: UnknownReason): UnknownPage => ({ kind: "unknown", reason });
export interface PageIdentity {
    eventId: string;
    sessionId: string;
}
export interface EventDetails {
    eventName: string;
    date: string;
    time: string;
}

export function single<T>(items: T[]): T | undefined {
    return items.length === 1 ? items[0] : undefined;
}

export function quantity(value: string): number | undefined {
    if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
    const result = Number(value);
    return Number.isSafeInteger(result) ? result : undefined;
}

export function validDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const validTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function readEventDetails(dom: TicketPlusDom): EventDetails | undefined {
    const identity = single(dom.identities);
    if (!identity?.name) return undefined;
    const date = single(identity.dates);
    const time = single(identity.times);
    if (!date || !time || !validDate(date) || !validTime(time)) return undefined;
    return { eventName: identity.name, date, time };
}
