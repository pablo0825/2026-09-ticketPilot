import { workerFor } from "./workerEntries.js";
import { executionPlatform } from "../app/platforms/index.js";
import { isStopMessage } from "./workerProtocol.js";
import { parseActivity } from "../config/activityStore.js";
import type { PurchaseLease } from "../app/purchaseLock.js";
import type { BrowserContext } from "playwright";
import { createParticipantGate } from "./participantConfirmation.js";

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
    void startWorker(message as { activity: unknown; lease: PurchaseLease });
}
process.on("message", receiveStart);

async function startWorker(input: { activity: unknown; lease: PurchaseLease }): Promise<void> {
    let context: BrowserContext | undefined;
    let closed: Promise<void> = Promise.resolve();
    let submitted = false;
    let settled = false;
    let closing = false;
    const controller = new AbortController();
    let stopType: string | undefined;

    // 同步準備停止接收器，啟動瀏覽器期間也能記住停止要求。
    const receiveStop = (message: unknown) => {
        if (!settled && isStopMessage(message, stopType)) {
            controller.abort();
        }
    };
    process.on("message", receiveStop);

    // 抽選等待參加者時，只接受本輪等待中的確認 ID 一次。
    let participants: ReturnType<typeof createParticipantGate> | undefined;
    const receiveParticipants = (message: unknown) => {
        if (!settled) participants?.receive(message);
    };
    process.on("message", receiveParticipants);

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
        const activity = parseActivity(input.activity);
        const definition = executionPlatform(activity.platform);
        stopType = definition.stop?.message.type;
        if (definition.participants) participants = createParticipantGate(definition.participants.messageType);
        const gate = participants;
        const result = await workerFor(activity.platform).run(
            { activity, lease: input.lease },
            {
                onBrowser,
                sendEvent: event => {
                    process.send?.({ type: "event", event });
                },
                onSubmitAttempt: () => {
                    submitted = true;
                },
                signal: controller.signal,
                waitForParticipants: gate ? confirmationId => gate.wait(confirmationId) : undefined,
            },
        );
        settled = true;
        process.send?.({ type: "result", ...result });
    } catch {
        const message = submitted
            ? "已嘗試提交，結果需人工確認；請檢查原頁面及訂單，不會重送。"
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
