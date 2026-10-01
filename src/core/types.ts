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

export interface TicketAdapter {
    // 僅完成 UI 選取與驗證；失敗拋錯，不建立訂單或進入下一步。
    selectAndVerify(target: TicketTarget): Promise<void>;
}
