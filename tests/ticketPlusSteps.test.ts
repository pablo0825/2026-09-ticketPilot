import assert from "node:assert/strict";
import { test } from "node:test";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";
import type { TicketPlusWorkerEvent } from "../src/local/purchaseEvents.js";
import { ticketPlusStepsView } from "../src/local/react/shared/runs/ticketPlusSteps.js";

const now = Date.parse("2026-10-20T03:00:00Z");

function run(overrides: Partial<PurchaseSnapshot>, stages: TicketPlusWorkerEvent["stage"][] = []): PurchaseSnapshot {
    return {
        platform: "ticketplus",
        id: "run-1",
        requestId: "request-1",
        activityName: "測試活動",
        flowType: "purchase",
        status: "running",
        browserOpen: true,
        occupied: true,
        message: "",
        historyTruncated: false,
        events: stages.map((stage, index) => ({
            sequence: index + 1,
            at: "2026-10-20T03:00:00Z",
            event:
                stage === "waiting-for-participants" || stage === "login-ready"
                    ? { type: "ticketplus", stage, confirmationId: "6a1f0c7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b" }
                    : { type: "ticketplus", stage },
        })),
        ...overrides,
    };
}

function states(view: ReturnType<typeof ticketPlusStepsView>) {
    return view!.steps.map(step => step.state);
}

test("四種流程組合：步驟數與步驟名稱依流程類型及開賣時間決定", () => {
    const labels = (snapshot: PurchaseSnapshot) =>
        ticketPlusStepsView(snapshot, false, now)!.steps.map(step => step.label);
    const saleAt = "2026-10-20T03:05:00Z";

    assert.deepEqual(labels(run({ flowType: "purchase" })), [
        "1. 啟動購票瀏覽器",
        "2. 確認登入",
        "3. 開啟活動頁",
        "4. 選擇場次",
        "5. 選擇票種並送出",
        "6. 送出購票資料",
        "7. 輪到你付款",
    ]);
    assert.equal(labels(run({ flowType: "purchase", saleAt })).length, 8);
    assert.equal(labels(run({ flowType: "purchase", saleAt }))[3], "4. 等待開賣");
    assert.deepEqual(labels(run({ flowType: "lottery" })).slice(5), [
        "6. 填寫參加者",
        "7. 送出參加者資料",
        "8. 輪到你確認登記",
    ]);
    assert.equal(labels(run({ flowType: "lottery", saleAt })).length, 9);
});

test("沒有流程類型的舊紀錄或其他平台不顯示步驟", () => {
    assert.equal(ticketPlusStepsView(run({ flowType: undefined }), false, now), undefined);
    assert.equal(ticketPlusStepsView(run({ platform: "klook", flowType: undefined }), false, now), undefined);
});

test("執行中：已經過的步驟完成，目前步驟轉圈，還沒輪到的等待", () => {
    assert.deepEqual(states(ticketPlusStepsView(run({}), false, now)), [
        "running",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
    ]);
    const view = ticketPlusStepsView(
        run({}, ["starting", "checking-login", "opening-activity", "selecting-session"]),
        false,
        now,
    );
    assert.deepEqual(states(view), ["done", "done", "done", "running", "pending", "pending", "pending"]);
    assert.equal(view!.badge.text, "執行中");
    assert.equal(view!.summary, "請勿操作購票瀏覽器。");
});

test("換順位、更新票數與晚到的排隊進度都不讓步驟倒退", () => {
    const stages: TicketPlusWorkerEvent["stage"][] = [
        "starting",
        "checking-login",
        "opening-activity",
        "selecting-session",
        "selecting-tickets",
        "submitting",
        "waiting-to-refresh",
        "refreshing",
        "selecting-tickets",
        "submitting-information",
        "queue",
    ];
    const view = ticketPlusStepsView(run({}, stages), false, now);
    assert.deepEqual(states(view), ["done", "done", "done", "done", "done", "running", "pending"]);
});

test("等待登入：確認登入這步輪到使用者", () => {
    const view = ticketPlusStepsView(run({}, ["starting", "checking-login", "waiting-for-login"]), false, now);
    assert.equal(view!.steps[1]!.state, "action");
    assert.match(view!.steps[1]!.note ?? "", /手動登入/);
    assert.equal(view!.badge.text, "等待你");
});

test("等待參加者：有確認 ID 時顯示按鈕，送出確認後改為轉圈", () => {
    const stages: TicketPlusWorkerEvent["stage"][] = [
        "starting",
        "selecting-session",
        "selecting-tickets",
        "submitting",
        "waiting-for-participants",
    ];
    const confirmation = { confirmationId: "6a1f0c7e-2b3d-4e5f-8a9b-0c1d2e3f4a5b" };
    const waiting = ticketPlusStepsView(
        run({ flowType: "lottery", participantConfirmation: confirmation }, stages),
        false,
        now,
    );
    assert.equal(waiting!.steps[5]!.state, "action");
    assert.equal(waiting!.steps[5]!.participantsButton, true);
    assert.equal(waiting!.steps.filter(step => step.participantsButton).length, 1);
    assert.match(waiting!.summary, /網站倒數結束前須完成/);

    const sent = ticketPlusStepsView(run({ flowType: "lottery" }, stages), false, now);
    assert.equal(sent!.steps[5]!.state, "running");
    assert.equal(sent!.steps[5]!.participantsButton, undefined);
    assert.equal(sent!.badge.text, "執行中");
});

test("停止要求送出後目前步驟維持轉圈，不顯示輪到你", () => {
    const view = ticketPlusStepsView(
        run({ stopRequest: { status: "sent" } }, ["starting", "checking-login", "waiting-for-login"]),
        false,
        now,
    );
    assert.equal(view!.steps[1]!.state, "running");
    assert.equal(view!.badge.text, "停止中");
    assert.equal(view!.title, "等待流程停止");
});

test("到付款頁或確認登記前：前面全部完成，最後一步輪到使用者", () => {
    const payment = ticketPlusStepsView(
        run({ status: "payment-ready", message: "已到同場次付款頁。" }, ["submitting-information"]),
        false,
        now,
    );
    assert.deepEqual(states(payment), ["done", "done", "done", "done", "done", "done", "action"]);
    assert.equal(payment!.steps[6]!.note, "已到同場次付款頁。");
    assert.equal(payment!.badge.text, "輪到你");

    const registration = ticketPlusStepsView(
        run({ flowType: "lottery", status: "registration-ready" }, ["completing-registration"]),
        false,
        now,
    );
    assert.equal(registration!.steps.at(-1)!.state, "action");
    assert.equal(registration!.title, "已停在確認登記前");
});

test("失敗：標在目前步驟並附原因，之後的步驟未執行", () => {
    const view = ticketPlusStepsView(
        run({ status: "failed", message: "場次選擇停止：找不到場次。" }, [
            "starting",
            "opening-activity",
            "selecting-session",
        ]),
        false,
        now,
    );
    assert.deepEqual(states(view), ["done", "done", "done", "failed", "skipped", "skipped", "skipped"]);
    assert.equal(view!.steps[3]!.note, "場次選擇停止：找不到場次。");
    assert.equal(view!.badge.text, "失敗");
    assert.equal(view!.title, "購票已停止");
});

test("使用者停止或時間上限：顯示已停止而非失敗", () => {
    for (const stopReason of ["user-stop", "time-limit"] as const) {
        const view = ticketPlusStepsView(run({ status: "failed", stopReason }, ["selecting-session"]), false, now);
        assert.equal(view!.steps[3]!.state, "stopped");
        assert.equal(view!.badge.text, "已停止");
    }
});

test("結果未確認或異常中斷：標成未確認，不標成失敗", () => {
    for (const status of ["unknown", "interrupted"] as const) {
        const view = ticketPlusStepsView(run({ status }, ["selecting-tickets", "submitting"]), false, now);
        assert.equal(view!.steps[4]!.state, "unknown");
        assert.equal(view!.badge.text, "請確認");
        assert.doesNotMatch(view!.summary, /失敗|售完/);
    }
});

test("停在資料頁：下一步交給使用者確認", () => {
    const view = ticketPlusStepsView(
        run({ flowType: "lottery", status: "information-ready" }, ["selecting-tickets", "submitting"]),
        false,
        now,
    );
    assert.equal(view!.steps[4]!.state, "done");
    assert.equal(view!.steps[5]!.state, "action");
    assert.equal(view!.badge.text, "請確認");
});

test("抽選流程的標題使用登記字眼", () => {
    assert.equal(
        ticketPlusStepsView(run({ flowType: "lottery" }, ["selecting-session"]), false, now)!.title,
        "正在登記",
    );
    assert.equal(
        ticketPlusStepsView(run({ flowType: "lottery", status: "failed" }, ["selecting-session"]), false, now)!.title,
        "登記已停止",
    );
    assert.equal(ticketPlusStepsView(run({}, ["selecting-session"]), false, now)!.title, "正在購票");
});

test("等待開賣時說明顯示倒數", () => {
    const view = ticketPlusStepsView(
        run({ saleAt: "2026-10-20T03:00:42Z" }, ["starting", "opening-activity", "waiting-for-sale"]),
        false,
        now,
    );
    assert.equal(view!.steps[3]!.state, "running");
    assert.match(view!.summary, /距開賣 42 秒/);
});
