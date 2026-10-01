import type { EventConfig } from "../core/types.js";

export const eventConfig: EventConfig = {
    // 移除分享網址中的 spm / clickId 追蹤參數。
    eventUrl: "https://www.klook.com/zh-TW/event-detail/102001017-boyfriend-taipei-26/",
    targets: [
        {
            // 已從活動資訊確認年份為 2026。
            date: "2026-10-03",
            time: "12:00",
            area: "A區",
            quantity: 1,
            adjacent: false, // 僅多張票時套用；單張保留網頁的連票勾選狀態。
        },
    ],
    fallbackMode: "STRICT",
    excludeKeywords: ["愛心席", "身障", "視線不良"],
};

// 此次 A 區一張的核對基準；更換活動、票種或張數時一併修改。
export const bookingExpectation = {
    eventName: "2026 BOYFRIEND FAN-CONCERT <Our 15th Season> IN TAIPEI",
    unitPrice: 4880,
    totalPrice: 4880,
};
