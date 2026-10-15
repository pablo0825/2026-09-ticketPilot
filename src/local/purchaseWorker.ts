import { runTicketPlusWorker } from "./ticketPlusWorker.js";
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

// 控制訊息不能消耗唯一一次啟動機會；開始後不接受第二份設定。
function receiveStart(message: unknown): void {
    if (
        !message ||
        typeof message !== "object" ||
        "type" in message ||
        !("activity" in message) ||
        !("lease" in message)
    )
        return;
    process.removeListener("message", receiveStart);
    void startWorker(message as { activity: unknown; contact?: unknown; lease: PurchaseLease });
}
process.on("message", receiveStart);

async function startWorker(input: { activity: unknown; contact?: unknown; lease: PurchaseLease }): Promise<void> {
    let context: BrowserContext | undefined;
    let closed: Promise<void> = Promise.resolve();
    let submitted = false;
    let settled = false;
    let closing = false;
    const controller = new AbortController();
    let ticketPlus = false;

    // 同步準備停止接收器，啟動瀏覽器期間也能記住停止要求。
    const receiveStop = (message: unknown) => {
        if (
            ticketPlus &&
            !settled &&
            message &&
            typeof message === "object" &&
            "type" in message &&
            message.type === "stop-ticketplus" &&
            Object.keys(message).length === 1
        ) {
            controller.abort();
        }
    };
    process.on("message", receiveStop);

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

    const onBrowser = (browser: BrowserContext) => {
        context = browser;
        closed = new Promise(resolve => browser.once("close", () => resolve()));
        process.send?.({ type: "browser", open: true });
        browser.once("close", () => process.send?.({ type: "browser", open: false }));
    };
    try {
        // 平台分流在聯絡資料驗證之前，Klook 保留原驗證與提交處理。
        const activity = parseActivity(input.activity);
        ticketPlus = activity.platform === "ticketplus";
        if (activity.platform === "ticketplus") {
            const result = await runTicketPlusWorker(
                activity,
                input.lease,
                onBrowser,
                event => {
                    process.send?.({ type: "event", event });
                },
                () => {
                    submitted = true;
                },
                controller.signal,
            );
            settled = true;
            process.send?.({ type: "result", ...result });
        } else {
            const config = toPurchaseConfig(activity);
            const contact = validateContactDetails(input.contact);

            // 把事件傳回主服務，並隱藏紀錄裡的個資
            const privateValues = Object.values(contact).filter(value => value.length > 1);
            const sendEvent = (event: RunEvent) => {
                // 必須在提交前就標記；runPurchase.ts 的 submitAndVerifyPayment 在 contactForm.submit() 前回報 CONTACT_SUBMISSION。
                // 若調整回報順序，提交結果不明時會被誤判為「未提交」。
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
                onBrowser,
            });

            settled = true;
            process.send?.({
                type: "result",
                outcome: "payment-ready",
                message: "已核對付款頁，請到購票瀏覽器手動付款。關閉該瀏覽器後才可開始下一場。",
            });
        }
    } catch (error) {
        const message = submitted
            ? "已嘗試提交，結果需人工確認；請檢查原頁面及訂單，不會重送。"
            : error instanceof PurchaseStop
              ? "購票已停止，請檢查原瀏覽器提示；不會自動重新開始。"
              : "購票流程中斷，請檢查原瀏覽器；不會自動重跑。";

        settled = true;
        process.send?.({ type: "result", outcome: submitted ? "unknown" : "failed", message });
    } finally {
        process.off("message", receiveStop);
    }

    // 等瀏覽器關閉後，才通知主服務結束
    if (context) await closed;
    process.send?.({ type: "finished" }, error => {
        finished = !error;
        process.disconnect?.();
    });
}
