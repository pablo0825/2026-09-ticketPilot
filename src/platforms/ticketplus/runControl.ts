// 停止原因不帶入外部 signal.reason，避免把任意資料寫入結果或日誌。
export class TicketPlusStopError extends Error {
    readonly stopReason = "user-stop" as const;
    constructor() {
        super("TicketPlus 使用者要求停止自動操作。");
    }
}

export class TicketPlusRunControl {
    constructor(readonly signal?: AbortSignal) {}

    check(): void {
        if (this.signal?.aborted) throw new TicketPlusStopError();
    }

    // 僅供唯讀操作；取消後原查詢可能收尾，但不得在回呼中點擊或導航。
    async read<T>(read: () => Promise<T>): Promise<T> {
        this.check();
        if (!this.signal) return read();
        const signal = this.signal;
        let cancel = () => {};
        try {
            const interrupted = new Promise<never>((_, reject) => {
                cancel = () => reject(new TicketPlusStopError());
                signal.addEventListener("abort", cancel, { once: true });
            });
            const operation = Promise.resolve().then(() => {
                this.check();
                return read();
            });
            const result = await Promise.race([operation, interrupted]);
            this.check();
            return result;
        } finally {
            signal.removeEventListener("abort", cancel);
        }
    }

    // 輪詢等待可立即停止，同時清除計時器與監聽。
    async wait(milliseconds: number): Promise<void> {
        this.check();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            await new Promise<void>((resolve, reject) => {
                cancel = () => reject(new TicketPlusStopError());
                this.signal?.addEventListener("abort", cancel, { once: true });
                timer = setTimeout(resolve, milliseconds);
            });
            this.check();
        } finally {
            clearTimeout(timer);
            this.signal?.removeEventListener("abort", cancel);
        }
    }
}
