import { TicketPlusCliInputError } from "./ticketPlusMessages.js";
import { readFile } from "node:fs/promises";
import { parseTicketPlusActivity, singleTicketPlusSelection } from "../config/ticketPlusActivity.js";
import { runTicketPlus } from "../app/runTicketPlus.js";
import { ticketPlusResultMessage, ticketPlusEventMessage } from "../app/ticketPlusPresentation.js";
export { ticketPlusResultMessage } from "../app/ticketPlusPresentation.js";
import { requireTicketPlusTerminal, waitForTicketPlusLogin } from "./ticketPlusLogin.js";
import type { TicketPlusTerminal } from "./ticketPlusLogin.js";

export const ticketPlusUsage =
    "用法：npm run start:ticketplus -- --config ./ticketplus.local.json\n可加 WEBDRIVER_EXPERIMENT=1；流程只到填寫資料頁。";
export async function loadTicketPlusCliSettings(args: string[]) {
    if (args.length !== 2 || args[0] !== "--config" || !args[1] || args[1].startsWith("--"))
        throw new TicketPlusCliInputError(ticketPlusUsage);
    let input: unknown;
    try {
        input = JSON.parse(await readFile(args[1], "utf8"));
    } catch {
        throw new TicketPlusCliInputError("無法讀取 TicketPlus 設定，請確認檔案存在且為 JSON。");
    }
    try {
        return parseTicketPlusActivity(input);
    } catch {
        throw new TicketPlusCliInputError(
            "TicketPlus 活動設定格式錯誤，請檢查活動網址、名稱、日期、時間、票種、張數，以及開賣時間與提前秒數。",
        );
    }
}
export async function runTicketPlusCli(
    args: string[],
    terminal: TicketPlusTerminal = { input: process.stdin, output: process.stdout },
    environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
    if (args.length === 1 && args[0] === "--help") {
        terminal.output.write(`${ticketPlusUsage}\n`);
        return 0;
    }
    // 錯誤設定與非互動終端在瀏覽器／占用鎖之前拒絕，不讀 Klook 聯絡資料。
    const settings = await loadTicketPlusCliSettings(args);
    singleTicketPlusSelection(settings);
    try {
        requireTicketPlusTerminal(terminal.input);
    } catch {
        throw new TicketPlusCliInputError("需要可互動的終端機，請勿使用管線自動送入 Enter。");
    }
    terminal.output.write(`WEBDRIVER_EXPERIMENT：${environment.WEBDRIVER_EXPERIMENT === "1" ? "開啟" : "關閉"}\n`);
    let closed: Promise<void> = Promise.resolve();
    const result = await runTicketPlus(settings, {
        webdriverExperiment: environment.WEBDRIVER_EXPERIMENT === "1",
        waitForLogin: page => waitForTicketPlusLogin(page, terminal),
        onEvent: event => {
            const message = ticketPlusEventMessage(event);
            if (message) terminal.output.write(`${message}\n`);
        },
        onBrowser: context => {
            closed = new Promise(resolve => context.once("close", () => resolve()));
        },
    });

    // 結果先顯示，瀏覽器留給人工操作；關閉後才結束 CLI。
    terminal.output.write(`${ticketPlusResultMessage(result)}\n操作結束後，請關閉購票瀏覽器視窗。\n`);
    await closed;
    return result.outcome === "information-ready" ? 0 : 1;
}
