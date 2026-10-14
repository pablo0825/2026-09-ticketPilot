import { ticketPlusStartupMessage } from "./cli/ticketPlusMessages.js";
import { runTicketPlusCli } from "./cli/ticketPlus.js";

runTicketPlusCli(process.argv.slice(2))
    .then(code => {
        process.exitCode = code;
    })
    .catch(error => {
        // 不輸出原始檔案、瀏覽器錯誤或個資；CLI 不會自行重啟購票。
        console.error(ticketPlusStartupMessage(error));
        process.exitCode = 1;
    });
