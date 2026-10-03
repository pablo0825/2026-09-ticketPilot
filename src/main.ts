import { eventConfig } from "./config/event.config.js";
import { loadContactDetails } from "./config/contact.config.js";
import { runPurchase } from "./app/runPurchase.js";
import { reportState } from "./core/state.js";

async function main(): Promise<void> {
    const contact = await loadContactDetails();
    await runPurchase(eventConfig, contact, { pause: process.env.FLOW_PAUSE });
}

main().catch((error: unknown) => {
    reportState("FAILED");
    console.error("流程已停止：", error);
    console.log("請保留畫面供檢查；不會自動重新整理或嘗試其他票種。");
    process.exitCode = 1;
});
