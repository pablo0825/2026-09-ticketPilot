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
} from "../src/storage/purchaseLock.js";

test("購票占用區分占用、建立失敗及驗證失敗，不清除或改寫原鎖", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticketplus-message-"));
    try {
        const lease = acquirePurchaseLease(dir);
        const original = readFileSync(lease.path, "utf8");
        assert.throws(
            () => acquirePurchaseLease(dir),
            error => {
                assert(error instanceof PurchaseLockError);
                assert.equal(error.reason, "occupied");
                return true;
            },
        );
        assert.equal(readFileSync(lease.path, "utf8"), original);
        assert.throws(
            () => verifyPurchaseLease({ ...lease, token: "wrong" }),
            error => {
                assert(error instanceof PurchaseLockError);
                assert.equal(error.reason, "verification-failed");
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
                return true;
            },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
