import { runWithRecovery, type FlowRecovery } from "./recovery.js";

interface BookingSteps<T> {
    selectSeats(): Promise<T>;
    confirmSeats(seats: T): Promise<void>;
    prepareContact(seats: T): Promise<void>;
}

// 只重跑提交前的準備流程。每次 attempt 都取得新座位，不沿用上一次結果。
export async function prepareBooking<T>(steps: BookingSteps<T>, queueRecovery: FlowRecovery,
    contactRecovery: FlowRecovery): Promise<void> {
    let activeRecovery: FlowRecovery | null = queueRecovery;
    const recovery: FlowRecovery = {
        isRequired: async () => activeRecovery !== null && await activeRecovery.isRequired(),
        recover: async () => {
            if (!activeRecovery) throw new Error("目前階段不允許恢復。");
            await activeRecovery.recover();
            activeRecovery = queueRecovery;
        },
    };

    // 所有階段使用同一個 runWithRecovery，因此共用一次額度。
    await runWithRecovery(async () => {
        activeRecovery = queueRecovery;
        const seats = await steps.selectSeats();

        // 座位確認或導頁失敗時，結果可能未知，不重試。
        activeRecovery = null;
        await steps.confirmSeats(seats);

        // 已確認到達個人資料頁，才允許辨識該頁的預留過期。
        activeRecovery = contactRecovery;
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        await steps.prepareContact(seats);
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        activeRecovery = null;
    }, recovery);
}
