import type { TicketPlusDom } from "./domSnapshot.js";
import { single, unknownPage } from "./readResult.js";
import type { PageIdentity, UnknownPage } from "./readResult.js";

export interface SeatConfirmationPage extends PageIdentity {
    kind: "seat-confirmation";
    seats: { area: string; position: string; ticketType: string }[];
    nextEnabled: boolean;
}

// 確認選位結果頁：唯一標題、每列四欄（票區、位置、票種、金額）、唯一下一步與取消購票。
export function parseSeatConfirmationPage(
    dom: TicketPlusDom,
    identity: PageIdentity,
): SeatConfirmationPage | UnknownPage {
    // 標題與按鈕必須唯一；重複即無法確定要按哪一顆。
    if (dom.seatResultHeadingCount > 1 || dom.nextButtons.length > 1 || dom.cancelButtons.length > 1) {
        return unknownPage("ambiguous-data");
    }

    const nextEnabled = single(dom.nextButtons);
    if (dom.seatResultHeadingCount !== 1 || nextEnabled === undefined || dom.cancelButtons.length !== 1) {
        return unknownPage("incomplete-data");
    }

    // 座位列前三欄必須有值；金額只確認存在，不核價。
    if (dom.checkout.length === 0) return unknownPage("incomplete-data");

    const seats: SeatConfirmationPage["seats"] = [];
    for (const columns of dom.checkout) {
        const [area, position, ticketType, price] = columns;
        if (columns.length !== 4) return unknownPage("incomplete-data");

        if (!area || !position || !ticketType || !price) return unknownPage("incomplete-data");

        seats.push({ area, position, ticketType });
    }

    return { kind: "seat-confirmation", ...identity, seats, nextEnabled };
}
