import { releasePurchaseLease } from "../../src/app/purchaseLock.js";
// 僅由測試建構子注入；HTTP 無法選擇 worker，不開浏览器或連網。
process.once("message", (input: any) => {
    if (input.activity.eventName === "CRASH") process.exit(1);
    process.send?.({ type: "browser", open: true });
    process.send?.({ type: "event", event: { type: "state", state: "PAYMENT_READY" } });
    process.send?.({ type: "event", event: { type: "log", message: `fixture ${input.activity.targets[0].area}` } });
    process.send?.({ type: "result", outcome: input.activity.eventName === "UNKNOWN" ? "unknown" : "payment-ready", message: "fixture：等待關閉瀏覽器" });
    setTimeout(() => {
        releasePurchaseLease(input.lease);
        process.send?.({ type: "browser", open: false });
        process.send?.({ type: "finished" }, () => { process.disconnect?.(); });
    }, 1200);
});
