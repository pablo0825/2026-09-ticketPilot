import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    acquirePurchaseLease,
    releasePurchaseLease,
    verifyPurchaseLease,
    PurchaseLockError,
} from "../src/app/purchaseLock.js";
import { ticketPlusStartupMessage, ticketPlusSessionMessage } from "../src/cli/ticketPlusMessages.js";
import { loadTicketPlusCliSettings } from "../src/cli/ticketPlus.js";

test("購票占用訊息區分占用、建立失敗及驗證失敗，不清除或改寫原鎖", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticketplus-message-"));
    try {
        const lease = acquirePurchaseLease(dir);
        const original = readFileSync(lease.path, "utf8");
        assert.throws(
            () => acquirePurchaseLease(dir),
            error => {
                assert(error instanceof PurchaseLockError);
                assert.equal(error.reason, "occupied");
                assert.match(ticketPlusStartupMessage(error), /購票占用尚未解除/);
                assert.match(ticketPlusStartupMessage(error), /不會自動清鎖/);
                return true;
            },
        );
        assert.equal(readFileSync(lease.path, "utf8"), original);
        assert.throws(
            () => verifyPurchaseLease({ ...lease, token: "wrong" }),
            error => {
                assert.match(ticketPlusStartupMessage(error), /識別不符/);
                return true;
            },
        );
        releasePurchaseLease(lease);
        const file = join(dir, "not-directory");
        writeFileSync(file, "private");
        assert.throws(
            () => acquirePurchaseLease(file),
            error => {
                assert(error instanceof PurchaseLockError);
                assert.equal(error.reason, "unavailable");
                assert.match(ticketPlusStartupMessage(error), /目錄權限與磁碟/);
                assert.doesNotMatch(ticketPlusStartupMessage(error), /private|not-directory/);
                return true;
            },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("CLI 僅顯示已分類訊息，未知錯誤不轉印私密資料", async () => {
    assert.doesNotMatch(ticketPlusStartupMessage(new Error("PRIVATE_COOKIE")), /PRIVATE_COOKIE/);
    try {
        await loadTicketPlusCliSettings([]);
        assert.fail("should reject");
    } catch (error) {
        assert.match(ticketPlusStartupMessage(error), /用法/);
    }
    const message = ticketPlusSessionMessage({ reason: "arrival-timeout", stage: "after-click-attempt" });
    assert.match(message, /等待選票頁逾時/);
    assert.match(message, /已嘗試點擊立即購買/);
    assert.match(message, /不會再次點擊/);
    assert.doesNotMatch(message, /尚未嘗試點擊立即購買/);
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
