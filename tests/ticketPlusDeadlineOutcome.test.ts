import assert from "node:assert/strict";
import { test } from "node:test";
import { TicketPlusStopError } from "../src/platforms/ticketplus/runControl.js";
import { stoppedSubmissionResult } from "../src/platforms/ticketplus/submissionOutcome.js";
import { ticketPlusResultMessage } from "../src/app/flows/ticketplus/runMessages.js";
import type { SubmissionProgress } from "../src/platforms/ticketplus/ticketSubmission.js";

test("期限結果保留未提交、排隊及已知失敗事實，訊息區分使用者停止", () => {
    const cases: { progress: SubmissionProgress; outcome: string; message: RegExp }[] = [
        {
            progress: { submitAttempted: false, dismissAttempted: false, sawQueue: false, dismissal: "not-attempted" },
            outcome: "stopped",
            message: /尚未嘗試選票提交/,
        },
        {
            progress: { submitAttempted: true, dismissAttempted: false, sawQueue: true, dismissal: "not-attempted" },
            outcome: "unknown",
            message: /結果未確認/,
        },
        {
            progress: {
                submitAttempted: true,
                dismissAttempted: false,
                sawQueue: true,
                failure: "sold-out",
                dismissal: "not-attempted",
            },
            outcome: "rejected",
            message: /已確認購票失敗/,
        },
        {
            progress: {
                submitAttempted: true,
                dismissAttempted: true,
                sawQueue: false,
                failure: "sold-out",
                dismissal: "confirmed",
            },
            outcome: "rejected",
            message: /已確認購票失敗/,
        },
    ];
    for (const item of cases) {
        const result = stoppedSubmissionResult(new TicketPlusStopError("time-limit"), item.progress);
        assert.equal(result.outcome, item.outcome);
        assert.equal(result.stopReason, "time-limit");
        assert.deepEqual(result.progress, { ...item.progress, failure: item.progress.failure });
        const message = ticketPlusResultMessage(result);
        assert.match(message, /最長.*時間/);
        assert.match(message, item.message);
        assert.doesNotMatch(message, /已依要求停止/);
    }
});
