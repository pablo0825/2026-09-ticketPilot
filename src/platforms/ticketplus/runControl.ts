export type TicketPlusStopReason = "user-stop" | "time-limit";

// 停止原因不帶入外部 signal.reason，避免把任意資料寫入結果或日誌。
export class TicketPlusStopError extends Error {
    constructor(readonly stopReason: TicketPlusStopReason = "user-stop") {
        super(stopReason === "time-limit" ? "TicketPlus 已達最長執行時間。" : "TicketPlus 使用者要求停止自動操作。");
    }
}

export class TicketPlusRunControl {
    private deadline: number | undefined;
    private started = false;
    private stopped: TicketPlusStopError | undefined;

    constructor(
        readonly signal?: AbortSignal,
        private readonly now = () => performance.now(),
    ) {}

    // 登入交接後啟動一次；換階段不能重設整趟期限。
    startDeadline(minutes?: number): void {
        this.check();
        if (this.started) throw new Error("TicketPlus 全程期限已啟動。");
        if (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
            throw new Error("TicketPlus 最長執行時間必須為 1 至 1440 的整數分鐘。");
        }
        this.started = true;
        if (minutes !== undefined) this.deadline = this.now() + minutes * 60_000;
    }

    check(): void {
        if (!this.stopped) {
            if (this.signal?.aborted) this.stopped = new TicketPlusStopError();
            else if (this.deadline !== undefined && this.now() >= this.deadline) {
                this.stopped = new TicketPlusStopError("time-limit");
            }
        }
        if (this.stopped) throw this.stopped;
    }

    // 每次操作重新取剩餘時間；到期直接停止，不傳入代表無限等待的零。
    remainingMs(): number {
        this.check();
        const remaining = this.deadline === undefined ? Infinity : this.deadline - this.now();
        if (remaining <= 0) {
            this.stopped = new TicketPlusStopError("time-limit");
            throw this.stopped;
        }
        return remaining;
    }

    // 僅供唯讀操作；取消後原查詢可能收尾，但不得在回呼中點擊或導航。
    async read<T>(read: () => Promise<T>): Promise<T> {
        this.check();
        if (!this.signal && this.deadline === undefined) return read();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel = () => {};
        try {
            // 手動停止與全程期限都能喚醒尚未完成的唯讀工作。
            const interrupted = new Promise<never>((_, reject) => {
                cancel = () => {
                    try {
                        this.check();
                    } catch (error) {
                        reject(error);
                    }
                };
                this.signal?.addEventListener("abort", cancel, { once: true });
                const watchDeadline = () => {
                    try {
                        const remaining = this.remainingMs();
                        if (Number.isFinite(remaining)) timer = setTimeout(watchDeadline, remaining);
                    } catch (error) {
                        reject(error);
                    }
                };
                watchDeadline();
            });
            const operation = Promise.resolve().then(() => {
                this.check();
                return read();
            });
            const result = await Promise.race([operation, interrupted]);
            this.check();
            return result;
        } finally {
            clearTimeout(timer);
            this.signal?.removeEventListener("abort", cancel);
        }
    }

    // 輪詢等待使用相同停止控制，並在任何終止路徑清除自身計時器。
    async wait(milliseconds: number): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await this.read(
                () =>
                    new Promise<void>(resolve => {
                        timer = setTimeout(resolve, milliseconds);
                    }),
            );
        } finally {
            clearTimeout(timer);
        }
    }
}
