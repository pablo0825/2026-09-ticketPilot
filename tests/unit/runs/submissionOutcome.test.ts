import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedSubmissionResult } from "../../../src/platforms/ticketplus/submissionOutcome.js";
import {
    emptySubmissionProgress,
    TicketPlusSubmissionError,
} from "../../../src/platforms/ticketplus/ticketSubmission.js";
import { TicketPlusStopError } from "../../../src/platforms/ticketplus/runControl.js";

test("提交結果：已送出選票後，座位核對失敗仍是明確停止，保留提交事實", () => {
    const progress = { ...emptySubmissionProgress(), submitAttempted: true };
    for (const reason of ["seat-mismatch", "seat-button-unavailable"] as const) {
        const result = stoppedSubmissionResult(new TicketPlusSubmissionError(reason, progress));
        assert.equal(result.outcome, "stopped");
        assert.equal(result.reason, reason);
        assert.equal(result.progress.submitAttempted, true);
    }
    // 其他提交後讀取失敗仍必須是不確定，不能一律改成明確停止。
    const unknown = stoppedSubmissionResult(new TicketPlusSubmissionError("read-failed", progress));
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.progress.submitAttempted, true);
});

test("提交結果：期限與手動停止的原因及控制欄位一致，不混淆已提交狀態", () => {
    for (const stopReason of ["time-limit", "user-stop"] as const) {
        for (const submitAttempted of [false, true]) {
            const result = stoppedSubmissionResult(new TicketPlusStopError(stopReason), {
                ...emptySubmissionProgress(),
                submitAttempted,
            });
            assert("reason" in result);
            assert.equal(result.reason, stopReason === "time-limit" ? "time-limit" : "user-stopped");
            assert.equal(result.stopReason, stopReason);
            assert.equal(result.outcome, submitAttempted ? "unknown" : "stopped");
            assert.equal(result.progress.submitAttempted, submitAttempted);
        }
    }
});
