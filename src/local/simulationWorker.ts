import { parseActivity, toPurchaseConfig } from "../config/activityStore.js";
import { validateContactDetails } from "../config/contact.config.js";
import { withRunEvents, log } from "../core/logger.js";
import { reportState } from "../core/state.js";
import { PriorityStrategy } from "../core/priorityStrategy.js";

// 第一批僅提供模擬。沒有 Playwright / runPurchase 入口，不可能從網頁啟動實站。
let finished = false;
process.once("disconnect", () => process.exit(finished ? 0 : 1));
process.once("message", async (input: unknown) => {
    try {
        const value = input as { activity?: unknown; contact?: unknown };
        const config = toPurchaseConfig(parseActivity(value.activity));
        validateContactDetails(value.contact);

        await withRunEvents(
            event => process.send?.({ type: "event", event }),
            async () => {
                reportState("STARTING");
                log("模擬執行：不開啟購票瀏覽器、不存取網站、不建立訂單。");
                const strategy = new PriorityStrategy(config);

                await new Promise(resolve => setTimeout(resolve, 200));
                reportState("TICKET_SELECTION");
                const selected = await strategy.select({
                    attempt: async target => ({ status: "matched", value: target.expectation.totalPrice }),
                    returnAfterFailure: async () => {
                        throw new Error("模擬不應返回網站");
                    },
                });

                log(`模擬目標：${selected.target.area} / ${selected.target.quantity} 張 / NT$${selected.value}`);
                await new Promise(resolve => setTimeout(resolve, 200));
                log("模擬完成。尚未執行登入、配位、個資提交或付款頁核對。");
            },
        );

        process.send?.({ type: "done" }, error => {
            finished = !error;
            process.disconnect?.();
        });
    } catch {
        process.send?.({ type: "failed" }, () => process.disconnect?.());
    }
});
