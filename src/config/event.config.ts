import type { PurchaseConfig } from "../core/types.js";

export const eventConfig: PurchaseConfig = {
    // 移除分享網址中的 spm / clickId 追蹤參數。
    eventUrl: "https://www.klook.com/zh-TW/event-detail/102001017-boyfriend-taipei-26/",
    targets: [
        {
            // 已從活動資訊確認年份為 2026。
            date: "2026-10-03",
            time: "12:00",
            area: "A區",
            quantity: 1,
            expectation: {
                eventName: "2026 BOYFRIEND FAN-CONCERT <Our 15th Season> IN TAIPEI",
                unitPrice: 4880,
                totalPrice: 4880,
            },
            adjacent: false, // 僅多張票時套用；單張保留網頁的連票勾選狀態。
        },
    ],
    fallbackMode: "STRICT",
    excludeKeywords: ["愛心席", "身障", "視線不良"],
};
