import { log } from "./logger.js";

export type PurchaseState = "STARTING" | "LOGIN_CHECK" | "WAITING_FOR_LOGIN" | "READY" | "EVENT_PAGE" | "TICKET_SELECTION"
    | "SELECTION_VERIFIED" | "SEAT_ASSIGNMENT" | "SEATS_VERIFIED"
    | "CONTACT_SUBMISSION" | "PAYMENT_READY" | "CONTACT_FILLING" | "CONTACT_VERIFIED" | "BOOKING_VERIFIED" | "RECOVERING" | "SEAT_CONFIRMATION" | "PERSONAL_INFO_READY" | "MANUAL_REQUIRED" | "FAILED";

export function reportState(state: PurchaseState): void {
    // 顯示傳入的狀態
    log(`State: ${state}`);
}
