import { runPurchase } from "../app/runPurchase.js";
import { parseActivity, toPurchaseConfig } from "../config/activityStore.js";
import { validateContactDetails } from "../config/contact.config.js";
import type { PurchaseLease } from "../app/purchaseLock.js";
import type { BrowserContext } from "playwright";
import type { RunEvent } from "../core/logger.js";
import { PurchaseStop } from "../core/purchaseStop.js";

// 父服務失聯即停止程序，保留占用標記供人工檢查；不能偷偷續購。
let finished = false;
process.once("disconnect", () => process.exit(finished ? 0 : 1));

process.once("message", async (input: { activity: unknown; contact: unknown; lease: PurchaseLease }) => {
    let context: BrowserContext | undefined;
    let closed: Promise<void> = Promise.resolve();
    let submitted = false;
    let settled = false;
    let closing = false;

    // 收到關閉指令時，關閉購票瀏覽器
    process.on("message", async (message: unknown) => {
        if (!message || typeof message !== "object" || !("type" in message) || message.type !== "close-browser") return;
        if (!settled || !context || closing) return;

        closing = true;
        try {
            await context.close();
        } catch {
            closing = false;
            process.send?.({ type: "close-error" });
        }
    });

    try {
        // 檢查設定與聯絡資料
        const config = toPurchaseConfig(parseActivity(input.activity));
        const contact = validateContactDetails(input.contact);

        // 把事件傳回主服務，並隱藏紀錄裡的個資
        const privateValues = Object.values(contact).filter(value => value.length > 1);
        const sendEvent = (event: RunEvent) => {
            if (event.type === "state" && event.state === "CONTACT_SUBMISSION") submitted = true;
            // 個資不進 IPC 日誌；原始 Playwright error/stdout 也不轉送。
            if (event.type === "log") {
                let message = event.message;
                for (const value of privateValues) message = message.split(value).join("[個資已隱藏]");
                event = { type: "log", message };
            }
            process.send?.({ type: "event", event });
        };

        // 執行購票，並回報瀏覽器開關
        await runPurchase(config, contact, {
            lease: input.lease,
            onEvent: sendEvent,
            onBrowser: browser => {
                context = browser;
                closed = new Promise(resolve => browser.once("close", () => resolve()));
                process.send?.({ type: "browser", open: true });
                browser.once("close", () => process.send?.({ type: "browser", open: false }));
            },
        });

        settled = true;
        process.send?.({
            type: "result",
            outcome: "payment-ready",
            message: "已核對付款頁，請到購票瀏覽器手動付款。關閉該瀏覽器後才可開始下一場。",
        });
    } catch (error) {
        const message = submitted
            ? "已嘗試提交，結果需人工確認；請檢查原頁面及訂單，不會重送。"
            : error instanceof PurchaseStop
              ? "購票已停止，請檢查原瀏覽器提示；不會自動重新開始。"
              : "購票流程中斷，請檢查原瀏覽器；不會自動重跑。";

        settled = true;
        process.send?.({ type: "result", outcome: submitted ? "unknown" : "failed", message });
    }

    // 等瀏覽器關閉後，才通知主服務結束
    if (context) await closed;
    process.send?.({ type: "finished" }, error => {
        finished = !error;
        process.disconnect?.();
    });
});
