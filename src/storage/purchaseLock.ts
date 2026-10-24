import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { localDataDirectory } from "./dataPaths.js";

export interface PurchaseLease {
    path: string;
    token: string;
}

export class PurchaseLockError extends Error {
    constructor(public readonly reason: "occupied" | "unavailable" | "verification-failed") {
        super(
            reason === "occupied"
                ? "購票瀏覽器仍被占用，或上次執行異常中斷；請先檢查原瀏覽器與訂單，不會自動重跑。"
                : reason === "unavailable"
                  ? "無法建立購票占用，請檢查 local-data 目錄權限與磁碟狀態。"
                  : "購票占用識別無法確認，請檢查原程序與占用檔案。",
        );
        this.name = "PurchaseLockError";
    }
}

export function purchaseLockPath(directory = localDataDirectory): string {
    return join(directory, "purchase.lock");
}

export function purchaseOccupied(directory?: string): boolean {
    return existsSync(purchaseLockPath(directory));
}

// 購票程序共用持久占用；異常退出保留檔案，不猜測訂單或自動解鎖。
export function acquirePurchaseLease(directory = localDataDirectory): PurchaseLease {
    const lease = { path: purchaseLockPath(directory), token: randomUUID() };
    try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        writeFileSync(lease.path, JSON.stringify({ token: lease.token, pid: process.pid }), {
            flag: "wx",
            mode: 0o600,
        });
    } catch (error) {
        const occupied = (error as NodeJS.ErrnoException).code === "EEXIST" && existsSync(lease.path);
        throw new PurchaseLockError(occupied ? "occupied" : "unavailable");
    }

    return lease;
}

export function verifyPurchaseLease(lease: PurchaseLease): void {
    try {
        const record = JSON.parse(readFileSync(lease.path, "utf8"));
        if (record.token !== lease.token) throw new PurchaseLockError("verification-failed");
    } catch {
        throw new PurchaseLockError("verification-failed");
    }
}

export function releasePurchaseLease(lease: PurchaseLease): void {
    verifyPurchaseLease(lease);
    unlinkSync(lease.path);
}
