import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

// 只接受採集函式，沒有購買／恢復 callback，Enter 不可能恢復購買。
export async function collectStoppedDiagnostics(
    capture: (label: "failure" | "returned") => Promise<void>,
    input: Readable & { isTTY?: boolean } = process.stdin,
    output: Writable = process.stdout,
): Promise<void> {
    async function save(label: "failure" | "returned") {
        try {
            await capture(label);
            output.write(`已保存 ${label} 診斷（僅白名單結構與文字）。\n`);
        } catch {
            output.write("無法安全保存診斷，購買仍保持停止；請人工保留必要畫面。\n");
        }
    }
    await save("failure");
    if (!input.isTTY) return;
    output.write("本次購買已終止。手動處理彈窗後按 Enter，只採集返回畫面；Ctrl+C 結束。\n");
    const reader = createInterface({ input, output, terminal: true });
    const captureReturn = await new Promise<boolean>(resolve => {
        reader.on("line", line => {
            if (!line.trim()) resolve(true);
        });
        reader.once("SIGINT", () => resolve(false));
        reader.once("close", () => resolve(false));
        const fail = () => resolve(false);
        input.once("error", fail);
        reader.once("close", () => input.removeListener("error", fail));
    });
    reader.close();
    input.pause();
    if (captureReturn) await save("returned");
}
