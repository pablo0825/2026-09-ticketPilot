import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Page } from "playwright";

export interface TicketPlusTerminal {
    input: Readable & { isTTY?: boolean };
    output: Writable;
}
export function requireTicketPlusTerminal(input: TicketPlusTerminal["input"]): void {
    if (!input.isTTY || input.destroyed || input.readableEnded)
        throw new Error("TicketPlus CLI 需要可互動的終端機，請勿使用管線自動送入 Enter。");
}
export async function waitForTicketPlusLogin(page: Page, terminal: TicketPlusTerminal): Promise<void> {
    // 只接受當次人工交接，取消或頁面關閉都不進入購票。
    requireTicketPlusTerminal(terminal.input);
    if (page.isClosed()) throw new Error("購票頁已關閉。");
    const reader = createInterface({ input: terminal.input, output: terminal.output, terminal: true });
    const cancel = () => reader.close();
    page.once("close", cancel);
    page.once("crash", cancel);
    try {
        await new Promise<void>((resolve, reject) => {
            reader.on("line", line => {
                if (line.trim() === "") resolve();
                else terminal.output.write("請直接按 Enter，或 Ctrl+C 取消。\n");
            });
            const stop = () => reject(new Error("人工登入交接已取消或頁面已關閉。"));
            reader.once("close", stop);
            reader.once("SIGINT", stop);
            terminal.input.once("error", stop);
            reader.once("close", () => terminal.input.removeListener("error", stop));
            terminal.output.write(
                "請在購票瀏覽器手動登入，並停在設定的活動頁。\n確認後按 Enter 開始選票；Ctrl+C 取消。\n",
            );
        });
    } finally {
        page.removeListener("close", cancel);
        page.removeListener("crash", cancel);
        reader.close();
        terminal.input.pause();
    }
}
