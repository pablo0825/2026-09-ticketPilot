import type { PurchaseConfig } from "../../src/core/types.js";

// 固定本機測試資料，不隨使用者的實際購票設定變動。
export const fixtureConfig: PurchaseConfig = {
    eventUrl: "https://www.klook.com/zh-TW/event-detail/test/",
    targets: [
        {
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
