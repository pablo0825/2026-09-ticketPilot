import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    acquirePurchaseLease,
    releasePurchaseLease,
    verifyPurchaseLease,
    PurchaseLockError,
} from "../../../src/storage/purchaseLock.js";

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

test("鎖檔格式無效或 token 不符時，驗證與解除皆失敗並保留原檔", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticketplus-invalid-lock-"));
    try {
        const lease = acquirePurchaseLease(dir);
        const invalidContents = [
            "{",
            "null",
            "true",
            "42",
            '"token"',
            "[]",
            JSON.stringify([{ token: lease.token }]),
            "{}",
            JSON.stringify({ token: null }),
            JSON.stringify({ token: 42 }),
            JSON.stringify({ token: true }),
            JSON.stringify({ token: [lease.token] }),
            JSON.stringify({ token: { value: lease.token } }),
            JSON.stringify({ token: "wrong" }),
        ];

        for (const content of invalidContents) {
            writeFileSync(lease.path, content);

            for (const operation of [verifyPurchaseLease, releasePurchaseLease]) {
                assert.throws(() => operation(lease), new PurchaseLockError("verification-failed"), content);
                assert.equal(readFileSync(lease.path, "utf8"), content);
            }
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("正確 token 可驗證與解除，允許額外欄位；缺少鎖檔仍回報驗證失敗", () => {
    const dir = mkdtempSync(join(tmpdir(), "ticketplus-valid-lock-"));
    try {
        const lease = acquirePurchaseLease(dir);
        const validRecords = [{ token: lease.token }, { token: lease.token, pid: process.pid, extra: "retained" }];

        for (const record of validRecords) {
            const content = JSON.stringify(record);
            writeFileSync(lease.path, content);

            verifyPurchaseLease(lease);
            assert.equal(readFileSync(lease.path, "utf8"), content);
            releasePurchaseLease(lease);
            assert.equal(existsSync(lease.path), false);
        }

        for (const operation of [verifyPurchaseLease, releasePurchaseLease]) {
            assert.throws(() => operation(lease), new PurchaseLockError("verification-failed"));
            assert.equal(existsSync(lease.path), false);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
