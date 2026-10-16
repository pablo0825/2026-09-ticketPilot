export interface DomReadDetail {
    field: "page.text" | "activity.dates" | "activity.times" | "activity.timeRanges" | "tickets.soldOut";
    operation: "read-inner-text" | "trim-inner-text";
    tagName:
        | "div"
        | "span"
        | "h1"
        | "h3"
        | "button"
        | "label"
        | "i"
        | "svg"
        | "path"
        | "circle"
        | "rect"
        | "g"
        | "text"
        | "other";
    namespace: "html" | "svg" | "other";
    valueType: "unread" | "undefined" | "object" | "boolean" | "number" | "bigint" | "string" | "symbol" | "function";
    rowIndex: number | null;
    elementIndex: number | null;
}

// 診斷由同次瀏覽器快照傳回；錯誤訊息不包含網站文字。
export class DomCaptureError extends Error {
    constructor(readonly detail: DomReadDetail) {
        super("TicketPlus DOM text capture failed");
        this.name = "DomCaptureError";
    }
}
