import type { PurchaseConfig } from "../core/types.js";

export const eventConfig: PurchaseConfig = {
    // 移除分享網址中的 spm / clickId 追蹤參數。
    eventUrl: "https://www.klook.com/zh-TW/event-detail/102001091-ben-taipie-concert/",
    targets: [
        {
            // 已從活動資訊確認年份為 2026。
            date: "2026-11-15",
            time: "17:00",
            area: "獨立靠近(單人票)",
            quantity: 2,
            expectation: {
                eventName: "2026 斑恩 Ben《還是想靠近你》個人專場演唱會",
                unitPrice: 1280,
                totalPrice: 2560,
            },
            adjacent: false, // 此場為站票，不要求連位；站票後續流程尚未驗證。
        },
    ],
    fallbackMode: "STRICT",
    excludeKeywords: ["愛心席", "身障", "視線不良"],
};
