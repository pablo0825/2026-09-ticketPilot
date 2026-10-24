import type { ChildProcess } from "node:child_process";

// IPC 回呼只代表傳送完成，不代表購票流程已停止。
export async function sendWorkerStop(child: ChildProcess, message: { type: string }): Promise<void> {
    if (!child.connected) throw new Error("購票程序已失聯，請查看目前狀態；不會重送停止要求。");
    await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off("disconnect", disconnected);
            child.off("exit", disconnected);
            child.off("error", disconnected);
            if (error) reject(new Error("停止要求傳送結果未確認，請查看目前狀態；不會自動重送。"));
            else resolve();
        };
        const disconnected = () => finish(new Error("disconnected"));
        const timer = setTimeout(disconnected, 5_000);
        child.once("disconnect", disconnected);
        child.once("exit", disconnected);
        child.once("error", disconnected);
        try {
            // false 代表 IPC 背壓，不等同傳送失敗；以回呼或期限結束等待。
            child.send(message, finish);
        } catch {
            disconnected();
        }
    });
}
