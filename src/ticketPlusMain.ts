import { runTicketPlusCli } from "./cli/ticketPlus.js";

runTicketPlusCli(process.argv.slice(2))
    .then(code => {
        process.exitCode = code;
    })
    .catch(() => {
        // 不輸出原始檔案、瀏覽器錯誤或個資；CLI 不會自行重啟購票。
        console.error(
            "TicketPlus 啟動未完成：請檢查 --config 設定、互動終端與購票占用。可用 --help 查看用法；不會自動重跑。",
        );
        process.exitCode = 1;
    });
