import { TicketPlusStopError } from "../platforms/ticketplus/runControl.js";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";

export async function waitForTicketPlusWorkerLogin(
    page: Page,
    ready: (confirmationId: string) => void,
    signal?: AbortSignal,
): Promise<void> {
    // 每次等待使用新識別碼，舊的、提早的與其他輪次確認都不能繼續。
    if (signal?.aborted) throw new TicketPlusStopError();
    if (page.isClosed()) throw new Error("購票頁已關閉。");
    const confirmationId = randomUUID();
    let cleanup = () => {};
    try {
        await new Promise<void>((resolve, reject) => {
            let pending = true;
            const finish = (error?: Error) => {
                if (!pending) return;
                pending = false;
                cleanup();
                error ? reject(error) : resolve();
            };
            const receive = (input: unknown) => {
                if (!input || typeof input !== "object") return;
                const message = input as Record<string, unknown>;
                if (
                    Object.keys(message).length !== 2 ||
                    message.type !== "confirm-ticketplus-login" ||
                    message.confirmationId !== confirmationId
                )
                    return;
                finish();
            };
            const abort = () => finish(new TicketPlusStopError());
            const cancel = () => finish(new Error("人工登入交接取消，購票頁已關閉或無法使用。"));

            // 接收器與取消監聽先就緒，再公告可確認，避免立即回覆時漏接。
            cleanup = () => {
                process.removeListener("message", receive);
                page.removeListener("close", cancel);
                page.removeListener("crash", cancel);
                signal?.removeEventListener("abort", abort);
            };
            process.on("message", receive);
            page.once("close", cancel);
            page.once("crash", cancel);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            if (pending) ready(confirmationId);
        });
    } finally {
        cleanup();
    }
}
