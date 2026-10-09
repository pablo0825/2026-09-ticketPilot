import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectRoot } from "../config/activityStore.js";

export interface PurchaseLease {
    path: string;
    token: string;
}
export function purchaseLockPath(directory = join(projectRoot, "local-data")): string {
    return join(directory, "purchase.lock");
}
export function purchaseOccupied(directory?: string): boolean {
    return existsSync(purchaseLockPath(directory));
}

// CLI 與 GUI 共用持久占用；異常退出保留檔案，不猜測訂單或自動解鎖。
export function acquirePurchaseLease(directory = join(projectRoot, "local-data")): PurchaseLease {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lease = { path: purchaseLockPath(directory), token: randomUUID() };
    try {
        writeFileSync(lease.path, JSON.stringify({ token: lease.token, pid: process.pid }), {
            flag: "wx",
            mode: 0o600,
        });
    } catch {
        throw new Error("購票瀏覽器仍被占用，或上次執行異常中斷；請先檢查原瀏覽器與訂單，不會自動重跑。");
    }
    return lease;
}
export function verifyPurchaseLease(lease: PurchaseLease): void {
    const record = JSON.parse(readFileSync(lease.path, "utf8"));
    if (record.token !== lease.token) throw new Error("購票占用識別不符。");
}
export function releasePurchaseLease(lease: PurchaseLease): void {
    verifyPurchaseLease(lease);
    unlinkSync(lease.path);
}
