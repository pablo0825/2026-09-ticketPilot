import { parseTicketPlusActivity } from "../config/platforms/ticketplus/activitySettings.js";
import { runTicketPlusWorker } from "./ticketPlusWorker.js";
import { createWorkerEntry, createWorkerRegistry } from "./workerProtocol.js";

// 只有購票子程序載入此清單；主服務只載入不含瀏覽器的執行規則。
export const workerFor = createWorkerRegistry([
    createWorkerEntry("ticketplus", parseTicketPlusActivity, runTicketPlusWorker),
]);
