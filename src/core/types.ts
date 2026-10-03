export interface TicketTarget {
    date: string;
    time: string;
    area: string;
    quantity: number;
    adjacent: boolean; // 多張票才套用，單張票不操作連票設定。
}

export interface SaleSchedule {
    saleAt: string; // 完整台灣時間，例如 2026-10-10T10:00:00+08:00。
    advanceSeconds?: 1 | 2; // 預設提前 1 秒刷新。
}

export interface EventConfig {
    saleSchedule?: SaleSchedule;
    eventUrl: string;
    targets: TicketTarget[];
    fallbackMode: "STRICT";
    excludeKeywords: string[];
}

export interface BookingExpectation {
    eventName: string;
    unitPrice: number;
    totalPrice: number;
}

export interface PurchaseTarget extends TicketTarget {
    expectation: BookingExpectation;
}

export interface PurchaseConfig extends EventConfig {
    targets: PurchaseTarget[];
}
