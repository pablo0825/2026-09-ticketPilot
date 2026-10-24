import assert from "node:assert/strict";
import { test } from "node:test";
import { ticketPlusSessionDiagnostic, ticketPlusSessionMessage } from "../src/workers/ticketplus/runMessages.js";

test("場次停止訊息區分點擊前後，不誤報重試", () => {
    const message = ticketPlusSessionMessage({ reason: "arrival-timeout", stage: "after-click-attempt" });
    assert.match(message, /等待選票頁逾時/);
    assert.match(message, /已嘗試點擊場次按鈕/);
    assert.match(message, /不會再次點擊/);
    assert.doesNotMatch(message, /尚未嘗試點擊場次按鈕/);
    assert.match(ticketPlusSessionMessage({ reason: "session-disabled", stage: "before-click" }), /不能僅據此判定/);
    assert.match(ticketPlusSessionMessage({ reason: "session-missing", stage: "before-click" }), /符合設定名稱的場次/);
});

test("場次診斷只放在診斷資料，使用者訊息維持停止說明", () => {
    const failure = {
        reason: "unexpected-page" as const,
        stage: "after-click-attempt" as const,
        diagnostic: { check: "page-state", snapshot: { pageKind: "unknown", unknownReason: "conflicting-page" } },
    };
    const message = ticketPlusSessionMessage(failure);
    assert.doesNotMatch(message, /conflicting-page|最後一次觀測/);
    assert.match(message, /不會再次點擊/);
    assert.match(message, /尚未嘗試選票提交/);

    const diagnostic = ticketPlusSessionDiagnostic(failure as Parameters<typeof ticketPlusSessionDiagnostic>[0]);
    assert.match(diagnostic ?? "", /conflicting-page/);
    assert.match(diagnostic ?? "", /最後一次觀測/);
    assert.match(diagnostic ?? "", /after-click-attempt/);
    assert.equal(ticketPlusSessionDiagnostic({ stage: "before-click" }), undefined);
});

test("活動頁等待紀錄呈現耗時與觀測次數", async () => {
    const { ticketPlusEventMessage } = await import("../src/workers/ticketplus/runMessages.js");
    assert.equal(
        ticketPlusEventMessage({ type: "activity-wait", elapsedMs: 1250, observations: 7 }),
        "活動頁核對等待：1250 毫秒，共觀測 7 次。",
    );
});

test("順位紀錄區分初次、同輪候補與更新後的新輪次", async () => {
    const { ticketPlusEventMessage } = await import("../src/workers/ticketplus/runMessages.js");
    const event = { type: "attempt-reset" as const, submissionAttempts: 0, nextPriorityIndex: 0 };
    assert.equal(ticketPlusEventMessage({ ...event, reason: "initial" }), undefined);
    assert.equal(ticketPlusEventMessage({ ...event, reason: "refreshed" }), "更新完成，從第一順位重新檢查。");
    assert.equal(
        ticketPlusEventMessage({ ...event, submissionAttempts: 1, nextPriorityIndex: 1, reason: "next-priority" }),
        "前次提交已確認售完且重新選票核對通過，檢查本輪剩餘順位。",
    );
});

test("順位全部沒票的訊息同時涵蓋已售完與暫無票券，不只寫售完", async () => {
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
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
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
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
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
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
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
    const progress = Object.freeze({ submitAttempted: true, dismissAttempted: false, sawQueue: false }) as never;
    assert.match(
        ticketPlusResultMessage({ outcome: "payment-ready", progress, submissionAttempts: 1 }),
        /付款頁.*不會按前往付款/,
    );
    const before = ticketPlusResultMessage({
        outcome: "stopped",
        reason: "information-stopped",
        informationFailure: "next-unavailable",
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

test("資料頁送出前達期限或停止：說明已保留在資料頁未送出，不寫尚未提交選票", async () => {
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
    const progress = Object.freeze({ submitAttempted: true, dismissAttempted: false, sawQueue: false }) as never;
    for (const [failure, stopReason, pattern] of [
        ["time-limit", "time-limit", /已達最長執行時間/],
        ["user-stopped", "user-stop", /已依要求停止/],
    ] as const) {
        const message = ticketPlusResultMessage({
            outcome: "stopped",
            reason: "information-stopped",
            informationFailure: failure,
            stopReason,
            progress,
            submissionAttempts: 1,
        });
        assert.match(message, pattern);
        assert.match(message, /已保留在資料頁、未送出/);
        assert.doesNotMatch(message, /尚未嘗試選票提交|提交後停止原因/);
    }
});

test("抽選結果訊息：停在確認登記前、等待中停止或頁面改變都說明未送出登記", async () => {
    const { ticketPlusResultMessage } = await import("../src/workers/ticketplus/runMessages.js");
    const progress = Object.freeze({ submitAttempted: true, dismissAttempted: false, sawQueue: false }) as never;
    assert.match(
        ticketPlusResultMessage({ outcome: "registration-ready", progress, submissionAttempts: 1 }),
        /已停在確認登記前.*不會送出登記/,
    );
    for (const [lotteryFailure, stopReason, pattern] of [
        ["participant-page-changed", undefined, /離開輸入資料頁/],
        ["user-stopped", "user-stop", /已依要求停止/],
        ["participant-incomplete", undefined, /參加者資料尚未填完/],
    ] as const) {
        const message = ticketPlusResultMessage({
            outcome: "stopped",
            reason: "lottery-stopped",
            lotteryFailure,
            progress,
            submissionAttempts: 1,
            ...(stopReason ? { stopReason } : {}),
        });
        assert.match(message, pattern);
        assert.match(message, /未送出登記/);
        assert.doesNotMatch(message, /結果未確認|提交後停止原因/);
    }
});

test("使用者訊息不含英文原因代碼，代碼改放在診斷資料", async () => {
    const { ticketPlusResultDiagnostic, ticketPlusResultMessage } =
        await import("../src/workers/ticketplus/runMessages.js");
    type Result = Parameters<typeof ticketPlusResultMessage>[0];
    const progress = Object.freeze({ submitAttempted: false, dismissAttempted: false, sawQueue: false });
    const cases: [Result, string, RegExp][] = [
        [
            {
                outcome: "stopped",
                reason: "login-stopped",
                progress,
                loginFailure: { reason: "menu-failed", summary: {} },
            } as unknown as Result,
            "menu-failed",
            /無法開啟會員選單/,
        ],
        [
            {
                outcome: "stopped",
                reason: "session-selection-stopped",
                progress,
                sessionFailure: { reason: "session-missing", stage: "before-click" },
            } as unknown as Result,
            "session-missing",
            /找不到符合設定名稱的場次/,
        ],
        [
            {
                outcome: "stopped",
                reason: "ticket-selection-stopped",
                progress,
                priorityFailure: "ticket-missing",
            } as unknown as Result,
            "ticket-missing",
            /找不到設定的票種/,
        ],
        [
            {
                outcome: "stopped",
                reason: "lottery-stopped",
                progress,
                lotteryFailure: "terms-unchecked",
                submissionAttempts: 1,
            } as unknown as Result,
            "terms-unchecked",
            /服務條款勾選未確認/,
        ],
        [
            {
                outcome: "stopped",
                reason: "information-stopped",
                progress,
                informationFailure: "next-unavailable",
                submissionAttempts: 1,
            } as unknown as Result,
            "next-unavailable",
            /下一步按鈕無法使用/,
        ],
        [
            {
                outcome: "stopped",
                reason: "startup-stopped",
                progress,
                activityLoginFailure: "unconfirmed",
            } as unknown as Result,
            "startup-stopped",
            /開啟活動頁後無法確認登入狀態/,
        ],
        [
            { outcome: "stopped", reason: "startup-stopped", progress } as unknown as Result,
            "startup-stopped",
            /流程已停止/,
        ],
    ];
    for (const [result, code, pattern] of cases) {
        const message = ticketPlusResultMessage(result);
        assert.match(message, pattern);
        assert.doesNotMatch(message, /[a-z]+-[a-z]+/);
        assert.match(ticketPlusResultDiagnostic(result) ?? "", new RegExp(`停止代碼：.*${code}`));
    }
});
