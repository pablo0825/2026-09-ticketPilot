// 選位與訂單摘要共用的配位資料；不包含 DOM 或操作流程。
export interface AssignedSeat {
    section: string;
    row: string;
    number: string;
}

export type Allocation =
    | { kind: "reserved"; seats: AssignedSeat[] }
    | { kind: "general"; group: string; quantity: number };

export function seatKey(seat: AssignedSeat): string {
    return JSON.stringify([seat.section, seat.row, seat.number]
        .map(text => text.normalize("NFKC").replace(/\s/g, "")));
}
