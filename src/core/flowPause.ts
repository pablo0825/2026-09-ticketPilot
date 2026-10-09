import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

type PausePoint = "seats" | "contact";

// 人工測試入口；不讀取 DOM，也不決定是否重試。
export class FlowPause {
    private used = false;
    private readonly point: PausePoint | undefined;

    constructor(
        value: string | undefined,
        private readonly input: Readable & { isTTY?: boolean } = process.stdin,
        private readonly output: Writable = process.stdout,
    ) {
        if (value !== undefined && value !== "" && value !== "seats" && value !== "contact") {
            throw new Error("FLOW_PAUSE 只能設定為 seats 或 contact。");
        }
        this.point = value === "seats" || value === "contact" ? value : undefined;
        if (this.point && !input.isTTY) {
            throw new Error("FLOW_PAUSE 需要可互動的終端機，請直接在終端機執行。");
        }
    }

    async waitAt(point: PausePoint): Promise<boolean> {
        if (this.used || this.point !== point) return false;
        this.used = true; // 恢復後不再次暫停。
        const label = point === "seats" ? "座位已核對，尚未按確認" : "個資已填寫並核對，尚未提交";
        this.output.write(
            `\n測試暫停：${label}。\n請等待網站出現過期彈窗，不要手動關閉彈窗。\n按 Enter 繼續原流程；Ctrl+C 取消。\n`,
        );
        const reader = createInterface({ input: this.input, output: this.output, terminal: true });
        try {
            await new Promise<void>((resolve, reject) => {
                reader.on("line", line => {
                    if (line.trim() === "") resolve();
                    else this.output.write("請直接按 Enter 繼續，或 Ctrl+C 取消。\n");
                });
                const cancel = () =>
                    reject(new DOMException("測試暫停已取消或終端輸入已關閉；流程停止。", "AbortError"));
                reader.once("SIGINT", cancel);
                reader.once("close", cancel);
                this.input.once("error", cancel);
                reader.once("close", () => this.input.removeListener("error", cancel));
            });
        } finally {
            reader.close();
            this.input.pause();
        }
        this.output.write("繼續原流程，重新檢查目前頁面；不強制觸發重試。\n");
        return true;
    }
}
