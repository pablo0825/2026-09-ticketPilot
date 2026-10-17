import type { Writable } from "node:stream";

// 只接受採集函式，沒有購買／恢復 callback；只採集一次失敗當下畫面。
export async function collectStoppedDiagnostics(
    capture: (label: "failure") => Promise<void>,
    output: Writable = process.stdout,
): Promise<void> {
    try {
        await capture("failure");
        output.write("已保存 failure 診斷（僅白名單結構與文字）。\n");
    } catch {
        output.write("無法安全保存診斷，購買仍保持停止；請人工保留必要畫面。\n");
    }
}
