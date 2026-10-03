import { spawn } from "node:child_process";
import { startLocalServer } from "./server.js";

const service = await startLocalServer();
console.log(`本機串接預覽（僅模擬）：${service.url}`);
if (!process.argv.includes("--no-open")) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const opener = spawn(command, [service.url], { stdio: "ignore" });
    opener.on("error", () => console.log("無法自動開頁，請手動開啟上方網址。"));
    opener.on("exit", code => { if (code) console.log("請手動開啟上方網址。"); });
}
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await service.close();
    process.exitCode = 0;
});
