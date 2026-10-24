import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PurchaseLease } from "../../src/storage/purchaseLock.js";

// 不開瀏覽器、不解除占用；送出測試訊息後等待主服務停止程序。
process.once("message", (input: { lease: PurchaseLease }) => {
    const directory = dirname(input.lease.path);
    appendFileSync(join(directory, "worker-starts.txt"), "started\n");
    const report: unknown = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    if (!report || typeof report !== "object") throw new Error("測試回報必須是物件。");
    process.send?.(report);
    // 無效訊息後的 finished 不能把本輪改成正常結束。
    process.send?.({ type: "finished" });
    setTimeout(() => {
        appendFileSync(join(directory, "worker-timeout.txt"), "主服務未停止程序\n");
        process.exit(1);
    }, 5_000);
});
