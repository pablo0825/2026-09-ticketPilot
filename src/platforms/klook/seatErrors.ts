import type { Page } from "playwright";
import { SeatExpiredBeforeConfirmationError } from "../../core/seatExpiry.js";

export async function throwIfSeatReservationExpired(page: Page): Promise<void> {
    // 提示在座位清單外；保留原本較廣的停止檢查，恢復模組再嚴格確認彈窗。
    const notices = page.getByText(/未於時限內確認[，,]\s*票券預留失敗/);
    for (const notice of await notices.all()) {
        if (await notice.isVisible()) {
            throw new SeatExpiredBeforeConfirmationError("票券預留已到期，已停止確認；僅在符合恢復條件時重新配位。");
        }
    }
}

export function throwIfSeatError(text: string): void {
    if (/選位失敗|已逾時|已超時|時間已到/.test(text)) {
        throw new Error("選位畫面顯示失敗或逾時，請人工檢查；未判定售罄。");
    }
}
