import type { TicketPlusPage, TicketPlusPageMarkers } from "./pageState.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type LotteryInputState = { kind: "input"; applicants: { filled: boolean }[] } | { kind: "other" };

// 同場次抽選「輸入資料」頁：可辨識的資料頁、頁面本體恰有一個參加者資訊區塊、沒有開啟的彈窗。
// 其他情況（倒數結束導頁、編輯表單開著、別的場次、確認登記頁）都回 other，由呼叫端決定停止或等待。
export function readTicketPlusLotteryInput(
    read: { page: TicketPlusPage; markers?: TicketPlusPageMarkers },
    session: VerifiedTicketPlusSession,
): LotteryInputState {
    const { page, markers } = read;
    if (
        !markers ||
        page.kind !== "information" ||
        page.eventId !== session.eventId ||
        page.sessionId !== session.sessionId ||
        markers.participantSections !== 1 ||
        markers.dialogs !== 0
    ) {
        return { kind: "other" };
    }
    return { kind: "input", applicants: markers.applicants.map(applicant => ({ ...applicant })) };
}
