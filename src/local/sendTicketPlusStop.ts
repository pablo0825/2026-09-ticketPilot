import type { ChildProcess } from "node:child_process";
import { sendWorkerStop } from "./sendWorkerStop.js";
import { ticketPlusDefinition } from "../app/platforms/ticketPlus.js";

// 舊呼叫端相容入口；實際傳送與防重送等待由共用函式處理。
export function sendTicketPlusStop(child: ChildProcess): Promise<void> {
    const stop = ticketPlusDefinition.stop;
    if (!stop) throw new Error("平台不支援停止。");
    return sendWorkerStop(child, stop.message);
}
