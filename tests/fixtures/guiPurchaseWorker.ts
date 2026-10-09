import { releasePurchaseLease } from "../../src/app/purchaseLock.js";
// 僅由測試建構子注入；HTTP 無法選擇 worker，不開浏览器或連網。
process.once("message", (input: any) => {
    if (input.activity.eventName === "CRASH") process.exit(1);
    process.send?.({ type: "browser", open: true });
    process.send?.({ type: "event", event: { type: "state", state: "PAYMENT_READY" } });
    process.send?.({ type: "event", event: { type: "log", message: `fixture ${input.activity.targets[0].area}` } });
    const result = () =>
        process.send?.({
            type: "result",
            outcome: input.activity.eventName.includes("UNKNOWN")
                ? "unknown"
                : input.activity.eventName.includes("FAILED")
                  ? "failed"
                  : "payment-ready",
            message: "fixture：等待關閉瀏覽器",
        });
    if (input.activity.eventName === "HOLD_WAIT") {
        process.send?.({ type: "event", event: { type: "state", state: "WAITING_FOR_SALE" } });
        setTimeout(() => process.send?.({ type: "event", event: { type: "state", state: "TICKET_SELECTION" } }), 300);
        setTimeout(result, 600);
    } else result();
    const finish = () => {
        releasePurchaseLease(input.lease);
        process.send?.({ type: "browser", open: false });
        process.send?.({ type: "finished" }, () => {
            process.disconnect?.();
        });
    };
    if (input.activity.eventName.startsWith("HOLD")) {
        let closing = false;
        process.on("message", (message: any) => {
            if (message?.type !== "close-browser" || closing) return;
            if (input.activity.eventName === "HOLD_ERROR") {
                process.send?.({ type: "close-error" });
                setTimeout(finish, 100);
                return;
            }
            closing = true;
            setTimeout(finish, 100);
        });
    } else setTimeout(finish, 1200);
});
