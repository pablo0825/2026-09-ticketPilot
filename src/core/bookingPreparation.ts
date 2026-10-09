import { SeatExpiredBeforeConfirmationError } from "./seatExpiry.js";
import { runWithRecovery, type FlowRecovery, type RecoveryAction } from "./recovery.js";

interface BookingSteps<T> {
    selectSeats(): Promise<T>;
    confirmSeats(seats: T): Promise<void>;
    prepareContact(seats: T): Promise<void>;
}

// 只重跑提交前的準備流程。每次 attempt 都取得新座位，不沿用上一次結果。
export async function prepareBooking<T>(
    steps: BookingSteps<T>,
    queueRecovery: FlowRecovery,
    contactRecovery: FlowRecovery,
    seatRecovery?: FlowRecovery,
): Promise<T> {
    let stage: "selection" | "seats" | "contact" | null = "selection";

    async function findActiveRecovery(): Promise<FlowRecovery | null> {
        let candidates: (FlowRecovery | undefined)[] = [];
        if (stage === "selection") candidates = [queueRecovery, seatRecovery];
        if (stage === "seats") candidates = [seatRecovery];
        if (stage === "contact") candidates = [contactRecovery];
        const matches: FlowRecovery[] = [];
        for (const candidate of candidates) {
            if (candidate && (await candidate.isRequired())) matches.push(candidate);
        }
        if (matches.length > 1) throw new Error("同時出現多種例外，已停止恢復。");
        return matches[0] ?? null;
    }

    async function findRecovery(): Promise<RecoveryAction | null> {
        const selected = await findActiveRecovery();
        if (!selected) return null;
        const kind = selected === queueRecovery ? "queue" : "reservation";
        return {
            kind,
            recover: async () => {
                // 扣額度後重新核對，但不可無聲切換恢復種類或對象。
                if ((await findActiveRecovery()) !== selected) {
                    throw new Error("例外狀態已變動，已停止恢復。");
                }
                await selected.recover(kind === "reservation" ? queueRecovery : undefined);
                stage = "selection";
            },
        };
    }

    // 獨立排隊一次；選位與個資共用預留額度一次，重跑不重設。
    return runWithRecovery(async () => {
        stage = "selection";
        const seats = await steps.selectSeats();

        // 預設不恢復確認／導頁失敗；只有確認前的明確過期錯誤可例外處理。
        stage = null;
        try {
            await steps.confirmSeats(seats);
        } catch (error) {
            if (error instanceof SeatExpiredBeforeConfirmationError && seatRecovery) {
                stage = "seats";
            }
            throw error;
        }

        // 已確認到達個人資料頁，才允許辨識該頁的預留過期。
        stage = "contact";
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        await steps.prepareContact(seats);
        if (await contactRecovery.isRequired()) throw new Error("個人資料預留已過期。");
        stage = null;
        return seats;
    }, findRecovery);
}
