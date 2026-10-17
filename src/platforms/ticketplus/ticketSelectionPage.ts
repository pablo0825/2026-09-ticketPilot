import type { TicketPlusDom } from "./domSnapshot.js";
import { quantity, readEventDetails, single, unknownPage } from "./readResult.js";
import type { EventDetails, PageIdentity, UnknownPage } from "./readResult.js";

export interface TicketRow {
    name: string;
    selectedQuantity: number;
    // selling 只是畫面文案，不保證庫存，也不代表可增加張數。
    saleStatus: "selling" | "sold-out";
    remainingQuantity: number | null;
    canIncrease: boolean;
    canDecrease: boolean;
}
export interface TicketSelectionPage extends PageIdentity, EventDetails {
    kind: "ticket-selection";
    tickets: TicketRow[];
    nextEnabled: boolean;
}

function parseTicket(row: TicketPlusDom["tickets"][number]): TicketRow | undefined {
    // 票名只來自名稱欄的直接文字，不把價格或庫存拼進名稱。
    const name = single(row.names);
    if (!name || row.soldOut > 1) return undefined;
    const statuses = row.statuses.map(value => value.replace(/\s+/g, " "));
    if (statuses.length !== 1) return undefined;
    const status = statuses[0]!;
    const remainingText = /^剩餘 (\d+)$/.exec(status)?.[1];
    const remaining = remainingText === undefined ? null : quantity(remainingText);
    if (remaining === undefined || (remaining === null && status !== "熱賣中")) return undefined;

    // 已售完列沒有計數器；矛盾的售完文字與控制項不視為正常。
    if (row.soldOut === 1) {
        if (remaining !== 0 || row.counterCount || row.plus.length || row.minus.length) return undefined;
        return {
            name,
            selectedQuantity: 0,
            saleStatus: "sold-out",
            remainingQuantity: 0,
            canIncrease: false,
            canDecrease: false,
        };
    }
    const countText = single(row.quantities);
    const count = countText === undefined ? undefined : quantity(countText);
    const canIncrease = single(row.plus);
    const canDecrease = single(row.minus);
    if (
        remaining === 0 ||
        row.counterCount !== 1 ||
        count === undefined ||
        canIncrease === undefined ||
        canDecrease === undefined
    ) {
        return undefined;
    }
    return {
        name,
        selectedQuantity: count,
        saleStatus: "selling",
        remainingQuantity: remaining,
        canIncrease,
        canDecrease,
    };
}

// 目標票種比對：票名完全相等（大小寫、全半形、內部空白都要一致），保留重複以便呼叫端判斷歧義。
export function findTargetTickets(tickets: TicketRow[], ticketType: string): TicketRow[] {
    return tickets.filter(ticket => ticket.name === ticketType);
}

export function parseTicketSelectionPage(
    dom: TicketPlusDom,
    identity: PageIdentity,
): TicketSelectionPage | UnknownPage {
    // 確認活動資訊與頁面控制項完整。
    const event = readEventDetails(dom);
    const nextEnabled = single(dom.nextButtons);
    if (!event || nextEnabled === undefined || dom.tickets.length === 0) return unknownPage("incomplete-data");

    // 逐列解析，任一列不完整就拒絕整份結果。
    const tickets: TicketRow[] = [];
    for (const row of dom.tickets) {
        const ticket = parseTicket(row);
        if (!ticket) return unknownPage("incomplete-data");
        tickets.push(ticket);
    }
    return { kind: "ticket-selection", ...identity, ...event, tickets, nextEnabled };
}
