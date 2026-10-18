import type { TicketPlusPage, TicketPlusPageMarkers } from "./pageState.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";

export type LotteryInputState =
    { kind: "input"; applicants: { filled: boolean }[] } | { kind: "editing" } | { kind: "other" };

// 同場次抽選「輸入資料」頁的狀態：
// input：可辨識的資料頁、頁面本體恰有一個參加者資訊區塊、沒有開啟的彈窗；
// editing：同一頁開著參加者編輯表單或關閉表單確認（使用者正在填寫）；
// other：倒數結束導頁、別的場次、未知彈窗、確認登記頁等，由呼叫端決定停止。
export function readTicketPlusLotteryInput(
    read: { page: TicketPlusPage; markers?: TicketPlusPageMarkers },
    session: VerifiedTicketPlusSession,
): LotteryInputState {
    const { page, markers } = read;
    const inputPath = `/confirm/${session.eventId}/${session.sessionId}`;
    if (
        !markers ||
        markers.origin !== "https://ticketplus.com.tw" ||
        markers.pathname.replace(/\/$/, "") !== inputPath ||
        markers.participantSections !== 1
    ) {
        return { kind: "other" };
    }
    if (markers.dialogs > 0) {
        return markers.participantDialogs === markers.dialogs ? { kind: "editing" } : { kind: "other" };
    }
    if (page.kind !== "information" || page.eventId !== session.eventId || page.sessionId !== session.sessionId) {
        return { kind: "other" };
    }
    return { kind: "input", applicants: markers.applicants.map(applicant => ({ ...applicant })) };
}
