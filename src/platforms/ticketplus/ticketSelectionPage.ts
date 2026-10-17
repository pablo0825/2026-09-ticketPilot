import type { TicketPlusDom } from "./domSnapshot.js";
import { quantity, readEventDetails, single, unknownPage } from "./readResult.js";
import type { EventDetails, PageIdentity, UnknownPage } from "./readResult.js";

export interface TicketRow {
    // 票區面板版型中列所屬的票區；票種列版型為 null。
    area: string | null;
    name: string;
    selectedQuantity: number;
    // selling 只是畫面文案，不保證庫存，也不代表可增加張數。
    // unavailable 是「暫無票券」：票被其他購票人保留中，之後可能釋出，不是售完。
    saleStatus: "selling" | "sold-out" | "unavailable";
    remainingQuantity: number | null;
    canIncrease: boolean;
    canDecrease: boolean;
}
export interface TicketArea {
    name: string;
    // 票區標題的剩餘張數；熱賣中為 null。
    remainingQuantity: number | null;
    expanded: boolean;
}
export interface TicketSelectionPage extends PageIdentity, EventDetails {
    kind: "ticket-selection";
    tickets: TicketRow[];
    // 票區面板版型的票區；票種列版型為空陣列。
    areas: TicketArea[];
    nextEnabled: boolean;
}

type DomTicket = TicketPlusDom["tickets"][number];
type DomArea = TicketPlusDom["areas"][number];

// 庫存文字：「剩餘 N」回傳 N，「熱賣中」回傳 null，其他文字回傳 undefined（無法辨識）。
function parseStock(text: string): number | null | undefined {
    const remainingText = /^剩餘 (\d+)$/.exec(text.replace(/\s+/g, " "))?.[1];
    if (remainingText !== undefined) return quantity(remainingText);
    return text === "熱賣中" ? null : undefined;
}

// 沒有計數器的列：已售完或暫無票券，兩者只能出現一個，且剩餘必須為 0。
function parseClosedTicket(
    row: DomTicket,
    name: string,
    area: string | null,
    remaining: number | null,
): TicketRow | undefined {
    if (row.soldOut + row.unavailable !== 1 || remaining !== 0) return undefined;
    if (row.counterCount || row.plus.length || row.minus.length) return undefined;
    return {
        area,
        name,
        selectedQuantity: 0,
        saleStatus: row.soldOut === 1 ? "sold-out" : "unavailable",
        remainingQuantity: 0,
        canIncrease: false,
        canDecrease: false,
    };
}

// 有計數器的列：讀出唯一的張數與加減按鈕狀態。
function readCounter(row: DomTicket): { count: number; canIncrease: boolean; canDecrease: boolean } | undefined {
    const countText = single(row.quantities);
    const count = countText === undefined ? undefined : quantity(countText);
    const canIncrease = single(row.plus);
    const canDecrease = single(row.minus);
    if (row.counterCount !== 1 || count === undefined || canIncrease === undefined || canDecrease === undefined) {
        return undefined;
    }
    return { count, canIncrease, canDecrease };
}

function parseListTicket(row: DomTicket): TicketRow | undefined {
    // 票名只來自名稱欄的直接文字，不把價格或庫存拼進名稱。
    const name = single(row.names);
    if (!name || row.area !== null) return undefined;
    const statuses = row.statuses.map(value => value.replace(/\s+/g, " "));
    if (statuses.length !== 1) return undefined;
    const remaining = parseStock(statuses[0]!);
    if (remaining === undefined) return undefined;

    // 售完或暫無票券的列沒有計數器；矛盾的文字與控制項不視為正常。
    if (row.soldOut || row.unavailable) return parseClosedTicket(row, name, null, remaining);
    const counter = readCounter(row);
    if (remaining === 0 || !counter) return undefined;
    return {
        area: null,
        name,
        selectedQuantity: counter.count,
        saleStatus: "selling",
        remainingQuantity: remaining,
        canIncrease: counter.canIncrease,
        canDecrease: counter.canDecrease,
    };
}

function parseAreaTicket(row: DomTicket, area: TicketArea): TicketRow | undefined {
    // 票區內的票種列沒有自己的庫存文字，庫存以票區標題為準。
    const name = single(row.names);
    if (!name || row.statuses.length !== 0) return undefined;
    if (row.soldOut || row.unavailable) return parseClosedTicket(row, name, area.name, area.remainingQuantity);
    const counter = readCounter(row);
    if (!counter) return undefined;

    // 標題剩餘 0 但有計數器：自己已選走最後一張時仍可購買；
    // 0 張時視為暫無票券（推測頁面未更新、他人剛取走），跳下一順位而不是停止。
    const held = area.remainingQuantity === 0 && counter.count === 0;
    return {
        area: area.name,
        name,
        selectedQuantity: counter.count,
        saleStatus: held ? "unavailable" : "selling",
        remainingQuantity: area.remainingQuantity,
        canIncrease: counter.canIncrease,
        canDecrease: counter.canDecrease,
    };
}

function parseArea(area: DomArea): TicketArea | undefined {
    // 票區標題必須恰有一個名稱與一個可辨識的庫存文字。
    const name = single(area.names);
    const stock = single(area.stock);
    const remaining = stock === undefined ? undefined : parseStock(stock);
    if (!name || remaining === undefined) return undefined;
    return { name, remainingQuantity: remaining, expanded: area.expanded };
}

// 目標票種比對：票種列版型比對票名，票區面板版型比對所屬票區。
// 名稱完全相等（大小寫、全半形、內部空白都要一致），保留重複以便呼叫端判斷歧義。
export function findTargetTickets(tickets: TicketRow[], ticketType: string): TicketRow[] {
    return tickets.filter(ticket => (ticket.area === null ? ticket.name : ticket.area) === ticketType);
}

function parseAreaLayout(dom: TicketPlusDom): { tickets: TicketRow[]; areas: TicketArea[] } | UnknownPage {
    // 每個票區都要可辨識；同名票區無法分辨目標。
    const areas: TicketArea[] = [];
    for (const value of dom.areas) {
        const area = parseArea(value);
        if (!area) return unknownPage("incomplete-data");
        areas.push(area);
    }
    if (new Set(areas.map(area => area.name)).size !== areas.length) return unknownPage("ambiguous-data");

    // 收合票區保留的隱藏張數非零，代表其他票區已有選票，無法確認其他票種為零，停止。
    if (dom.areas.some(area => area.hiddenQuantities.some(value => value !== "0"))) {
        return unknownPage("incomplete-data");
    }

    // 展開的票區恰有一列票種，收合的票區沒有可見的票種列；不屬於任何票區的列代表版型混雜。
    const tickets: TicketRow[] = [];
    for (const area of areas) {
        const rows = dom.tickets.filter(row => row.area === area.name);
        // 展開票區有多種票時無法確定目標（設定只寫票區名稱），回報歧義。
        if (area.expanded && rows.length > 1) return unknownPage("ambiguous-data");
        if (rows.length !== (area.expanded ? 1 : 0)) return unknownPage("incomplete-data");
        if (rows.length === 0) continue;

        const ticket = parseAreaTicket(rows[0]!, area);
        if (!ticket) return unknownPage("incomplete-data");
        tickets.push(ticket);
    }
    if (tickets.length !== dom.tickets.length) return unknownPage("incomplete-data");
    return { tickets, areas };
}

export function parseTicketSelectionPage(
    dom: TicketPlusDom,
    identity: PageIdentity,
): TicketSelectionPage | UnknownPage {
    // 確認活動資訊與頁面控制項完整。
    const event = readEventDetails(dom);
    const nextEnabled = single(dom.nextButtons);
    if (!event || nextEnabled === undefined || (dom.tickets.length === 0 && dom.areas.length === 0)) {
        return unknownPage("incomplete-data");
    }

    // 票區面板版型：以票區解析。
    if (dom.areas.length > 0) {
        const layout = parseAreaLayout(dom);
        if ("kind" in layout) return layout;
        return { kind: "ticket-selection", ...identity, ...event, ...layout, nextEnabled };
    }

    // 票種列版型：逐列解析，任一列不完整就拒絕整份結果。
    const tickets: TicketRow[] = [];
    for (const row of dom.tickets) {
        const ticket = parseListTicket(row);
        if (!ticket) return unknownPage("incomplete-data");
        tickets.push(ticket);
    }
    return { kind: "ticket-selection", ...identity, ...event, tickets, areas: [], nextEnabled };
}
