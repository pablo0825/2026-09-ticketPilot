import type { Page } from "playwright";
import { DomCaptureError } from "./domReadFailure.js";
import type { DomReadDetail } from "./domReadFailure.js";

export type ReadStep = "read-url-before" | "capture-dom" | "read-url-after" | "validate-url" | "classify-page";
export type RouteKind = "activity" | "order" | "confirmSeat" | "confirm" | "checkout" | "other";
export interface ReadFailureDiagnostic {
    step: ReadStep;
    domRead?: DomReadDetail;
    category: "navigation-interrupted" | "page-closed" | "target-closed" | "other-read-error";
    pageClosed: boolean | null;
    routeBefore: RouteKind | null;
    routeAfter: RouteKind | null;
    urlChanged: boolean | null;
}

export function diagnosticRouteKind(pathname: string): RouteKind {
    if (/^\/activity\/[A-Za-z0-9_-]+\/?$/.test(pathname)) return "activity";

    for (const kind of ["order", "confirmSeat", "confirm", "checkout"] as const) {
        if (new RegExp(`^/${kind}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/?$`).test(pathname)) return kind;
    }

    return "other";
}

function routeKind(url: string | undefined): RouteKind | null {
    if (url === undefined) return null;

    try {
        return diagnosticRouteKind(new URL(url).pathname);
    } catch {
        return "other";
    }
}

export function diagnoseReadFailure(
    error: unknown,
    page: Page,
    step: ReadStep,
    before: string | undefined,
    after: string | undefined,
): ReadFailureDiagnostic {
    // 失敗後只讀本機頁面狀態，不重新擷取 DOM；診斷本身不得拋出錯誤。
    let pageClosed: boolean | null = null;
    let message = "";
    try {
        pageClosed = page.isClosed();
    } catch {
        /* 無法取得時保留未知。 */
    }
    try {
        after ??= page.url();
    } catch {
        /* 網址未知不能當作未改變。 */
    }
    try {
        if (error instanceof Error) {
            const candidate = error.message;
            if (typeof candidate === "string") message = candidate;
        }
    } catch {
        /* 不信任例外物件的 getter。 */
    }

    // 僅辨識明確訊息，未知錯誤不猜測成導頁，也不輸出原始文字。
    const category =
        pageClosed === true
            ? "page-closed"
            : /Target page, context or browser has been closed|Target closed/i.test(message)
              ? "target-closed"
              : /Execution context was destroyed/i.test(message)
                ? "navigation-interrupted"
                : "other-read-error";

    return {
        step,
        category,
        ...(step === "capture-dom" && error instanceof DomCaptureError ? { domRead: { ...error.detail } } : {}),
        pageClosed,
        routeBefore: routeKind(before),
        routeAfter: routeKind(after),
        urlChanged: before === undefined || after === undefined ? null : before !== after,
    };
}
