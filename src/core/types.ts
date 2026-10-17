export interface TicketTarget {
    date: string;
    time: string;
    area: string;
    quantity: number;
    bundle?: string;
    adjacent: boolean; // 多張票才套用，單張票不操作連票設定。
}

export interface SaleSchedule {
    saleAt: string; // 完整台灣時間，例如 2026-10-10T10:00:00+08:00。
    advanceSeconds?: 1 | 2; // 預設提前 1 秒刷新。
}

export interface TicketOptions {
    bundleEnabled?: boolean;
    deliveryMethod?: string;
}

export interface EventConfig extends TicketOptions {
    saleSchedule?: SaleSchedule;
    queueEnabled?: boolean;
    eventUrl: string;
    targets: TicketTarget[];
    fallbackMode: "STRICT";
    excludeKeywords: string[];
}

export interface BookingExpectation {
    eventName: string;
}

export interface PurchaseTarget extends TicketTarget {
    expectation: BookingExpectation;
}

export interface PurchaseConfig extends EventConfig {
    targets: PurchaseTarget[];
}

// 舊格式輸入可保留金額欄位；入口會忽略，內部只保留活動名稱。
export type PurchaseConfigInput = Omit<PurchaseConfig, "targets"> & {
    targets: (Omit<PurchaseTarget, "expectation"> & {
        expectation: BookingExpectation & { currency?: unknown; unitPrice?: unknown; totalPrice?: unknown };
    })[];
};
