import { readFile } from "node:fs/promises";
import { parseTicketPlusActivity } from "../config/ticketPlusActivity.js";
import { runTicketPlus } from "../app/runTicketPlus.js";
import type { TicketPlusRunEvent, TicketPlusRunResult } from "../app/runTicketPlus.js";
import { requireTicketPlusTerminal, waitForTicketPlusLogin } from "./ticketPlusLogin.js";
import type { TicketPlusTerminal } from "./ticketPlusLogin.js";

export const ticketPlusUsage =
    "用法：npm run start:ticketplus -- --config ./ticketplus.local.json\n可加 WEBDRIVER_EXPERIMENT=1；流程只到填寫資料頁。";
export async function loadTicketPlusCliSettings(args: string[]) {
    if (args.length !== 2 || args[0] !== "--config" || !args[1] || args[1].startsWith("--"))
        throw new Error(ticketPlusUsage);
    let input: unknown;
    try {
        input = JSON.parse(await readFile(args[1], "utf8"));
    } catch {
        throw new Error("無法讀取 TicketPlus 設定，請確認檔案存在且為 JSON。");
    }
    return parseTicketPlusActivity(input);
}
export function ticketPlusResultMessage(result: TicketPlusRunResult): string {
    if (result.outcome === "information-ready")
        return "已到同場次填寫資料頁，本階段完成。請人工接手；未填資料、未勾條款、未操作付款。";
    if (result.outcome === "unknown") return "已嘗試提交，結果未確認。請檢查原頁面及訂單；不會重送。";
    if (result.outcome === "rejected") {
        const reason = result.progress.failure === "sold-out" ? "已售完" : "購票失敗";
        const dismissal =
            result.progress.dismissal === "confirmed"
                ? "彈窗已確認關閉"
                : result.progress.dismissal === "disappeared"
                  ? "彈窗已消失，未嘗試關閉"
                  : "彈窗關閉未確認";
        return `${reason}，${dismissal}。流程停止，不刷新、不切換候補。`;
    }
    return `流程已停止（${result.reason}），尚未嘗試選票提交。請檢查購票瀏覽器；不會自動重跑。`;
}
function eventMessage(event: TicketPlusRunEvent): string | undefined {
    if (event.type === "lease-release-failed") return "無法釋放購票占用，請人工檢查；不會自動解除。";
    if (event.type === "stage") {
        return {
            starting: "啟動 TicketPlus 購票瀏覽器。",
            "waiting-for-login": "等待人工登入交接。",
            "selecting-session": "核對活動並選擇場次。",
            "selecting-tickets": "核對票種並調整張數。",
            submitting: "核對選票並提交，等待資料頁。",
        }[event.stage];
    }
    if (event.progress.failure) return "偵測到明確購票失敗，完成彈窗處理後停止。";
    if (event.progress.sawQueue) return "排隊購票中，等待網站處理，不重送。";
    if (event.progress.submitAttempted) return "已開始一次提交嘗試，結果尚待確認。";
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
    requireTicketPlusTerminal(terminal.input);
    terminal.output.write(`WEBDRIVER_EXPERIMENT：${environment.WEBDRIVER_EXPERIMENT === "1" ? "開啟" : "關閉"}\n`);
    let closed: Promise<void> = Promise.resolve();
    const result = await runTicketPlus(settings, {
        webdriverExperiment: environment.WEBDRIVER_EXPERIMENT === "1",
        waitForLogin: page => waitForTicketPlusLogin(page, terminal),
        onEvent: event => {
            const message = eventMessage(event);
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
