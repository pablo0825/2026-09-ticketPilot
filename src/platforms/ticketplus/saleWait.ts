import type { Page } from "playwright";
import { validateSaleSchedule } from "../../core/saleSchedule.js";
import type { TicketPlusRunControl } from "./runControl.js";

// 開賣時間依日曆時鐘核對；購票期限由 runner 在等待完成後另行啟動。
export async function waitForTicketPlusSale(
    page: Page,
    saleAt: string,
    control: TicketPlusRunControl,
    now: () => number = Date.now,
): Promise<void> {
    const timestamp = validateSaleSchedule({ saleAt });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    let closed = () => {};

    // 分段核對可處理系統調時與遠期日期，並即時回應停止及頁面關閉。
    try {
        await new Promise<void>((resolve, reject) => {
            const check = () => {
                try {
                    control.check();
                    if (page.isClosed()) throw new Error("等待開賣時購票頁已關閉。");

                    const current = now();
                    if (!Number.isFinite(current)) throw new Error("無法核對開賣時間。");

                    const remaining = timestamp - current;
                    if (remaining <= 0) resolve();
                    else timer = setTimeout(check, Math.min(remaining, 250));
                } catch (error) {
                    reject(error);
                }
            };

            cancel = () => {
                try {
                    control.check();
                } catch (error) {
                    reject(error);
                }
            };

            closed = () => reject(new Error("等待開賣時購票頁已關閉或中斷。"));
            control.signal?.addEventListener("abort", cancel, { once: true });
            page.on("close", closed);
            page.on("crash", closed);
            check();
        });
        control.check();
        if (page.isClosed()) throw new Error("等待開賣時購票頁已關閉。");
    } finally {
        // 所有結束路徑均移除監聽與計時器，不留下到點後的工作。
        clearTimeout(timer);
        control.signal?.removeEventListener("abort", cancel);
        page.off("close", closed);
        page.off("crash", closed);
    }
}
