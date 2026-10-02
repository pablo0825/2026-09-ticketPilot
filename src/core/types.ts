export interface TicketTarget {
    date: string;
    time: string;
    area: string;
    quantity: number;
    adjacent: boolean; // 多張票才套用，單張票不操作連票設定。
}

export interface EventConfig {
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
