import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketPlusSessionMessage } from "../src/app/ticketPlusPresentation.js";

test("場次停止訊息區分點擊前後，不誤報重試", () => {
    const message = ticketPlusSessionMessage({ reason: "arrival-timeout", stage: "after-click-attempt" });
    assert.match(message, /等待選票頁逾時/);
    assert.match(message, /已嘗試點擊場次按鈕/);
    assert.match(message, /不會再次點擊/);
    assert.doesNotMatch(message, /尚未嘗試點擊場次按鈕/);
    assert.match(ticketPlusSessionMessage({ reason: "session-disabled", stage: "before-click" }), /不能僅據此判定/);
    assert.match(ticketPlusSessionMessage({ reason: "session-missing", stage: "before-click" }), /該順位的日期與時間/);
});

test("場次診斷會出現在使用者訊息，既有停止說明維持不變", () => {
    const message = ticketPlusSessionMessage({
        reason: "unexpected-page",
        stage: "after-click-attempt",
        diagnostic: { check: "page-state", snapshot: { pageKind: "unknown", unknownReason: "conflicting-page" } },
    });
    assert.match(message, /conflicting-page/);
    assert.match(message, /最後一次觀測/);
    assert.match(message, /after-click-attempt/);
    assert.match(message, /不會再次點擊/);
    assert.match(message, /尚未嘗試選票提交/);
});

test("活動頁等待紀錄呈現耗時與觀測次數", async () => {
    const { ticketPlusEventMessage } = await import("../src/app/ticketPlusPresentation.js");
    assert.equal(
        ticketPlusEventMessage({ type: "activity-wait", elapsedMs: 1250, observations: 7 }),
        "活動頁核對等待：1250 毫秒，共觀測 7 次。",
    );
});

test("順位紀錄區分初次、同輪候補與更新後的新輪次", async () => {
    const { ticketPlusEventMessage } = await import("../src/app/ticketPlusPresentation.js");
    const event = { type: "attempt-reset" as const, submissionAttempts: 0, nextPriorityIndex: 0 };
    assert.equal(ticketPlusEventMessage({ ...event, reason: "initial" }), undefined);
    assert.equal(ticketPlusEventMessage({ ...event, reason: "refreshed" }), "更新完成，從第一順位重新檢查。");
    assert.equal(
        ticketPlusEventMessage({ ...event, submissionAttempts: 1, nextPriorityIndex: 1, reason: "next-priority" }),
        "前次提交已確認售完且重新選票核對通過，檢查本輪剩餘順位。",
    );
});

test("順位全部沒票的訊息同時涵蓋已售完與暫無票券，不只寫售完", async () => {
    const { ticketPlusResultMessage } = await import("../src/app/ticketPlusPresentation.js");
    type Result = Parameters<typeof ticketPlusResultMessage>[0];
    const message = ticketPlusResultMessage({
        outcome: "stopped",
        reason: "priority-stopped",
        progress: { submitAttempted: false },
        priorityFailure: "all-targets-sold-out",
    } as unknown as Result);
    assert.match(message, /皆已售完或暫無票券/);
});

test("提醒彈窗無法關閉的停止訊息說明尚未選場次", async () => {
    const { ticketPlusResultMessage } = await import("../src/app/ticketPlusPresentation.js");
    const progress = Object.freeze({
        submitAttempted: false,
        dismissAttempted: false,
        sawQueue: false,
    }) as never;
    const opening = ticketPlusResultMessage({
        outcome: "stopped",
        reason: "startup-stopped",
        noticeFailure: "notice-dismiss-failed",
        progress,
    });
    assert.match(opening, /提醒彈窗無法確認關閉/);
    assert.match(opening, /尚未選場次/);
    const sale = ticketPlusResultMessage({
        outcome: "stopped",
        reason: "sale-wait-stopped",
        saleFailure: "notice-dismiss-failed",
        progress,
    });
    assert.match(sale, /提醒彈窗無法確認關閉/);
});

test("場次停止訊息：流程類型不符說明檢查設定", () => {
    assert.match(ticketPlusSessionMessage({ reason: "flow-mismatch", stage: "before-click" }), /流程類型/);
});

test("確認選位停止訊息：不符與未確認各有說明，不會重試", async () => {
    const { ticketPlusResultMessage } = await import("../src/app/ticketPlusPresentation.js");
    const progress = Object.freeze({ submitAttempted: true, dismissAttempted: false, sawQueue: false }) as never;
    assert.match(
        ticketPlusResultMessage({ outcome: "stopped", reason: "seat-mismatch", progress }),
        /選位結果與設定的票區或張數不符.*座位仍在網站保留中/,
    );
    assert.match(
        ticketPlusResultMessage({ outcome: "unknown", reason: "seat-confirm-unconfirmed", progress }),
        /已確認選位，但未能確認抵達資料頁.*不會重試/,
    );
});

test("付款頁與資料頁停止訊息：點擊前停止說明未送出，點擊後說明未確認", async () => {
    const { ticketPlusResultMessage } = await import("../src/app/ticketPlusPresentation.js");
    const progress = Object.freeze({ submitAttempted: true, dismissAttempted: false, sawQueue: false }) as never;
    assert.match(
        ticketPlusResultMessage({ outcome: "payment-ready", progress, submissionAttempts: 1 }),
        /付款頁.*不會按前往付款/,
    );
    const before = ticketPlusResultMessage({
        outcome: "stopped",
        reason: "information-stopped",
        informationFailure: "contact-missing",
        progress,
        submissionAttempts: 1,
    });
    assert.match(before, /已保留在資料頁、未送出/);
    assert.doesNotMatch(before, /結果未確認/);
    assert.match(
        ticketPlusResultMessage({
            outcome: "unknown",
            reason: "information-stopped",
            informationFailure: "checkout-not-reached",
            progress,
            submissionAttempts: 1,
        }),
        /未能確認抵達付款頁.*不會重按/,
    );
});
