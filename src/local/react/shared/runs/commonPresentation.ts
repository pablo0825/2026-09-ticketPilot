import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";

export type StopRequestStatus = NonNullable<PurchaseSnapshot["stopRequest"]>["status"];

export function stopRequestPresentation(status: StopRequestStatus) {
    const messages = {
        sending: { title: "正在送出停止要求", instruction: "請稍候；停止要求送出前，流程可能仍在執行。" },
        sent: { title: "等待流程停止", instruction: "已送出停止要求，尚不代表流程已停止；請查看後續執行結果。" },
        unconfirmed: {
            title: "停止要求尚未確認",
            instruction: "無法確認停止要求是否送達，請檢查目前流程與購票瀏覽器；不會自動重送。",
        },
    };
    return messages[status];
}

export interface RunStatusText {
    title: string;
    instruction: string;
}

export const defaultRunningStatus: RunStatusText = {
    title: "正在購票",
    instruction: "程式正在依照設定執行，請稍候。",
};

export function stateRunningStatus(run: PurchaseSnapshot, now: number): RunStatusText {
    // 取得最近一次狀態，沒有專用提示時沿用一般文案。
    const stateEvent = run.events.filter(item => item.event.type === "state").at(-1)?.event;
    const state = stateEvent?.type === "state" ? stateEvent.state : undefined;
    let { title, instruction } = defaultRunningStatus;

    // 依目前狀態顯示提示。
    if (state === "WAITING_FOR_LOGIN") {
        title = "請手動登入";
        instruction = "請到購票瀏覽器完成登入，完成後會自動繼續。";
    } else if (state === "QUEUE_COUNTDOWN") {
        title = "等待排隊開賣";
        instruction = "等待網站倒數結束，請保留瀏覽器分頁。";
    } else if (state === "WAITING_IN_QUEUE") {
        title = "排隊中";
        instruction = "等待輪到購票，網站可能自動刷新；請勿手動刷新或離隊。";
    } else if (state === "QUEUE_CONTINUING") {
        title = "等待進入購票頁";
        instruction = "已嘗試繼續預訂，正在核對購票頁；不會重複點擊。";
    } else if (state === "WAITING_FOR_SALE") {
        title = "等待開賣";
        const saleAt = Date.parse(run.saleAt ?? "");
        if (Number.isFinite(saleAt)) {
            const seconds = Math.max(0, Math.ceil((saleAt - now) / 1000));
            instruction =
                `開賣時間：${new Date(saleAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}（台灣時間）。` +
                (seconds > 0 ? `距開賣 ${seconds} 秒，程式會自動繼續。` : "已到設定時間，正在等待開賣頁面。");
        } else {
            instruction = "正在等待設定的開賣時間，程式會自動繼續。";
        }
    } else if (state === "MANUAL_REQUIRED" || state === "FAILED") {
        title = "購票已停止";
        instruction = "請檢查購票瀏覽器的提示。程式正在完成停止處理，不會自動重新購票。";
    }

    return { title, instruction };
}

export function finishedStatus(run: PurchaseSnapshot, closingBrowser: boolean): RunStatusText {
    let title: string;
    let instruction: string;

    // 依瀏覽器與程序狀態決定結尾提醒。
    let ending: string;
    if (run.browserOpen) {
        ending = "檢查完成後請關閉購票瀏覽器，才能開始下一場。";
    } else if (run.occupied) {
        ending = "尚未確認程序正常結束，請先檢查原瀏覽器及執行紀錄。";
    } else {
        ending = "購票程序已結束，請先確認訂單狀態，再決定是否購買下一場。";
    }

    // 依購票結果顯示交接或停止提示。
    if (run.status === "information-ready") {
        title = "已到填寫資料頁";
        instruction = run.browserOpen
            ? "本階段完成，請到購票瀏覽器人工接手填寫資料與後續流程；程式未操作條款或付款。" + ending
            : "購票瀏覽器已關閉；本程式只核對到填寫資料頁，未核對付款結果。" + ending;
    } else if (run.status === "registration-ready") {
        title = "已停在確認登記前";
        instruction = run.browserOpen
            ? "請到購票瀏覽器自行檢查登記內容並按「確認登記」；程式不會送出登記。" + ending
            : "購票瀏覽器已關閉；本程式未送出登記，請自行確認登記狀態。" + ending;
    } else if (run.status === "payment-ready") {
        title = "已到付款頁";
        if (run.browserOpen) {
            instruction = "請到購票瀏覽器手動完成付款。完成後請關閉該瀏覽器，才能開始下一場。";
        } else if (run.occupied) {
            instruction = "購票瀏覽器已關閉，正在等待程序結束；本程式未核對付款結果。";
        } else {
            instruction = "購票瀏覽器已關閉。本程式未核對付款結果，請自行確認訂單。";
        }
    } else {
        title = "購票已停止";
        if (run.status === "unknown") {
            instruction = "提交結果尚未確認，請檢查購票頁面及訂單；程式不會重新提交。";
        } else if (run.status === "interrupted") {
            instruction = "程序異常中斷，請檢查原購票瀏覽器及訂單；程式不會自動重跑。";
        } else {
            instruction = "未能完成購票流程，請檢查購票瀏覽器的提示與執行紀錄；程式不會自動重新開始。";
        }
        instruction += ending;
    }

    // 關閉期間只替換提示，保留結果標題。
    if (closingBrowser) {
        instruction = "正在關閉購票瀏覽器，請稍候；確認程序結束後才會解除占用。";
    }

    return { title, instruction };
}
