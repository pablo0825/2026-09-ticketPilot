import { SeatExpiredBeforeConfirmationError } from "./seatExpiry.js";
import { runWithRecovery, type FlowRecovery } from "./recovery.js";

interface BookingSteps<T> {
    selectSeats(): Promise<T>;
    confirmSeats(seats: T): Promise<void>;
    prepareContact(seats: T): Promise<void>;
}

// 只重跑提交前的準備流程。每次 attempt 都取得新座位，不沿用上一次結果。
export async function prepareBooking<T>(steps: BookingSteps<T>, queueRecovery: FlowRecovery,
    contactRecovery: FlowRecovery, seatRecovery?: FlowRecovery): Promise<void> {
    async function findSelectionRecovery(): Promise<FlowRecovery | null> {
        const matches: FlowRecovery[] = [];
        for (const candidate of [queueRecovery, seatRecovery]) {
            if (candidate && await candidate.isRequired()) matches.push(candidate);
        }
        if (matches.length > 1) throw new Error("同時出現多種選票／選位例外，已停止恢復。");
        return matches[0] ?? null;
    }
    const selectionRecovery: FlowRecovery = {
        isRequired: async () => await findSelectionRecovery() !== null,
        recover: async () => {
            const selected = await findSelectionRecovery();
            if (!selected) throw new Error("選票／選位例外已變動，已停止恢復。");
            await selected.recover(selected === queueRecovery ? undefined : queueRecovery);
        },
    };
    let activeRecovery: FlowRecovery | null = selectionRecovery;
    const recovery: FlowRecovery = {
        isRequired: async () => activeRecovery !== null && await activeRecovery.isRequired(),
        recover: async () => {
            if (!activeRecovery) throw new Error("目前階段不允許恢復。");
            await activeRecovery.recover(activeRecovery === selectionRecovery ? undefined : queueRecovery);
            activeRecovery = selectionRecovery;
        },
    };

    // 所有階段使用同一個 runWithRecovery，因此共用一次額度。
    await runWithRecovery(async () => {
        activeRecovery = selectionRecovery;
        const seats = await steps.selectSeats();

        // 預設不恢復確認／導頁失敗；只有確認前的明確過期錯誤可例外處理。
        activeRecovery = null;
        try {
            await steps.confirmSeats(seats);
        } catch (error) {
            if (error instanceof SeatExpiredBeforeConfirmationError && seatRecovery) {
                activeRecovery = seatRecovery;
            }
            throw error;
        }

        // 已確認到達個人資料頁，才允許辨識該頁的預留過期。
        activeRecovery = contactRecovery;
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        await steps.prepareContact(seats);
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        activeRecovery = null;
    }, recovery);
}
