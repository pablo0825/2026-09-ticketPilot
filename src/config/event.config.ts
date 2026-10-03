import type { PurchaseConfig } from "../core/types.js";

export const eventConfig: PurchaseConfig = {
    eventUrl: "https://www.klook.com/zh-TW/event-detail/102000938-jason-mraz-2026-taipei-concert/",
    targets: [
        {
            date: "2026-11-02",
            time: "19:30",
            area: "B區",
            quantity: 1,
            expectation: {
                eventName: "Jason Mraz ASIA TOUR 2026 IN TAIPEI",
                unitPrice: 5280,
                totalPrice: 5280,
            },
            adjacent: false, // 單張不適用連位要求。
        },
        {
            date: "2026-11-02",
            time: "19:30",
            area: "C區",
            quantity: 1,
            expectation: {
                eventName: "Jason Mraz ASIA TOUR 2026 IN TAIPEI",
                unitPrice: 4880,
                totalPrice: 4880,
            },
            adjacent: false,
        },
    ],
    fallbackMode: "STRICT",
    excludeKeywords: ["愛心席", "身障", "視線不良"],
};
