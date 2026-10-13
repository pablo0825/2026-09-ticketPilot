import { appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { releasePurchaseLease, type PurchaseLease } from "../../src/app/purchaseLock.js";

// 只計算實際收到啟動的子程序，不開啟網站或購票。
process.once("message", (input: { lease: PurchaseLease }) => {
    appendFileSync(join(dirname(input.lease.path), "worker-starts.txt"), "started\n");
    process.send?.({ type: "result", outcome: "failed", message: "fixture 已結束" });
    releasePurchaseLease(input.lease);
    process.send?.({ type: "finished" }, () => process.disconnect?.());
});
