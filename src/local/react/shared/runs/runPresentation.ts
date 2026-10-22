import type { TicketPlusWorkerEvent } from "../../../purchaseEvents.js";
import type { PurchaseSnapshot } from "../../../purchaseRuns.js";

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

interface RunStatusText {
    title: string;
    instruction: string;
}

type TicketPlusStage = TicketPlusWorkerEvent["stage"];
type FixedTicketPlusStage = Exclude<TicketPlusStage, "waiting-for-sale" | "waiting-for-participants">;

const defaultRunningStatus: RunStatusText = {
    title: "正在購票",
    instruction: "程式正在依照設定執行，請稍候。",
};

const ticketPlusStageStatus: Record<FixedTicketPlusStage, RunStatusText> = {
    // 這些階段沿用一般執行提示。
    starting: defaultRunningStatus,
    "selecting-session": defaultRunningStatus,
    "selecting-tickets": defaultRunningStatus,
    "checking-login": {
        title: "確認登入狀態",
        instruction: "等待 TicketPlus 首頁的會員狀態載入；確認已登入後會自動前往活動頁。",
    },
    "waiting-for-login": {
        title: "請手動登入",
        instruction: "請在購票瀏覽器完成登入。系統確認登入成功後會自動前往活動頁，依設定繼續。",
    },
    "opening-activity": {
        title: "前往活動頁",
        instruction: "已確認登入，正在開啟設定的活動頁；接著會核對活動與場次。",
    },
    "login-ready": {
        title: "舊版登入交接紀錄",
        instruction: "這是舊版人工確認狀態，目前不提供登入確認操作；請檢查原流程。",
    },
    "refreshing-activity": {
        title: "刷新活動頁",
        instruction: "正在重新載入活動頁並核對目標場次；仍可要求停止。",
    },
    "waiting-for-availability": {
        title: "等待目標場次開賣",
        instruction: "目標場次仍尚未開賣，間隔至少 3 秒再次刷新；最多等待至開賣後 2 分鐘，仍可要求停止。",
    },
    queue: {
        title: "排隊中",
        instruction: "等待 TicketPlus 處理，請保留購票頁面；程式不會刷新或重送。",
    },
    "waiting-to-refresh": {
        title: "等待更新票數",
        instruction: "本輪設定順位已耗盡，短暫等待後核對更新票數；仍可要求停止。",
    },
    refreshing: {
        title: "更新票數核對中",
        instruction: "最多嘗試一次更新；未確認完成前不會開始新一輪選票。",
    },
    "completing-registration": {
        title: "核對參加者並前往確認登記",
        instruction: "正在核對參加者已填、勾選服務條款並按一次下一步；不會按確認登記。",
    },
    "submitting-information": {
        title: "送出資料頁",
        instruction: "已到資料頁，正在勾選服務條款並按一次下一步，等待付款頁；不會按前往付款。",
    },
    submitting: {
        title: "提交並等待網站處理",
        instruction: "正在核對選票並進行一次提交流程，等待填寫資料頁；不會重送。",
    },
};

export function purchaseStatus(run: PurchaseSnapshot, closingBrowser: boolean, now: number): RunStatusText {
    // 已結束的流程顯示結果。
    if (run.status !== "running") {
        return finishedStatus(run, closingBrowser);
    }

    // TicketPlus 的停止要求優先於階段提示。
    if (run.platform === "ticketplus" && run.stopRequest) {
        return stopRequestPresentation(run.stopRequest.status);
    }

    // 有 TicketPlus 進度時，顯示對應階段。
    const stage = latestTicketPlusStage(run);
    if (run.platform === "ticketplus" && stage !== undefined) {
        return ticketPlusRunningStatus(run, stage, now);
    }

    // 尚無 TicketPlus 事件時，保留依 state 顯示提示的回退行為。
    return stateRunningStatus(run, now);
}

export function latestTicketPlusStage(run: PurchaseSnapshot): TicketPlusStage | undefined {
    const event = run.events.filter(item => item.event.type === "ticketplus").at(-1)?.event;
    return event?.type === "ticketplus" ? event.stage : undefined;
}

function ticketPlusRunningStatus(run: PurchaseSnapshot, stage: TicketPlusStage, now: number): RunStatusText {
    // 等待開賣時顯示倒數。
    if (stage === "waiting-for-sale") {
        return ticketPlusSaleStatus(run.saleAt, now);
    }

    // 確認已送出後後端不再提供確認 ID，提示改為等待程式核對。
    if (stage === "waiting-for-participants") {
        return {
            title: "請填寫參加者",
            instruction: run.participantConfirmation
                ? "請在購票瀏覽器填寫所有參加者，完成後按「參加者已填完」；網站倒數結束前須完成。等待期間不計入最長執行時間，程式不會讀取或填寫參加者資料。"
                : "已送出參加者已填完，等待程式核對並前往確認登記；如長時間沒有進展，請檢查購票瀏覽器或按停止。",
        };
    }

    // 其餘階段使用固定提示。
    return { ...(ticketPlusStageStatus[stage] ?? defaultRunningStatus) };
}

function ticketPlusSaleStatus(saleAtText: string | undefined, now: number): RunStatusText {
    // 依開賣時間顯示倒數或一般等待提示。
    let instruction: string;
    const saleAt = Date.parse(saleAtText ?? "");
    if (Number.isFinite(saleAt)) {
        const seconds = Math.max(0, Math.ceil((saleAt - now) / 1000));
        instruction =
            `開賣時間：${new Date(saleAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}（台灣時間）。` +
            (seconds > 0
                ? `距開賣 ${seconds} 秒；程式會依設定提前刷新活動頁。`
                : "已到設定時間，等待購票程序更新進度；不會由此畫面重新啟動。");
    } else {
        instruction = "等待指定開賣時間，程式會依設定提前刷新活動頁。";
    }

    return { title: "等待開賣", instruction };
}

function stateRunningStatus(run: PurchaseSnapshot, now: number): RunStatusText {
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

function finishedStatus(run: PurchaseSnapshot, closingBrowser: boolean): RunStatusText {
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

export function eventLogs(events: PurchaseSnapshot["events"], truncated: boolean): string {
    const lines = events.flatMap(item => {
        const event = item.event;
        let message: string;
        if (event.type === "log") message = event.message;
        else if (event.type === "target") {
            message = `嘗試順位 ${event.index}/${event.total}：${event.date} ${event.time}／${event.area}／${event.quantity} 張`;
        } else if (event.type === "recovery") message = `恢復額度：排隊 ${event.queue}/1；預留 ${event.reservation}/1`;
        else if (event.type === "ticketplus") message = `TicketPlus 階段：${event.stage}`;
        else return [];
        return [new Date(item.at).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" }) + "  " + message];
    });
    return (truncated ? "較早紀錄已省略。\n" : "") + lines.join("\n");
}

// 首頁只呈現進行中或待處理的流程，不展示歷史結果。
export function platformRunStatus(purchase: PurchaseSnapshot | null) {
    // 正在使用瀏覽器的流程優先於過去的異常紀錄
    if (purchase && (purchase.occupied || purchase.browserOpen || purchase.status === "running")) {
        return { label: platformPurchaseLabel(purchase), kind: "purchase" as const };
    }
    // 提交不明或異常中斷不能只因解除占用就當成正常結束
    if (purchase && ["unknown", "interrupted"].includes(purchase.status)) {
        return { label: "需要人工確認", kind: "purchase" as const };
    }
    return { label: "可使用", kind: null };
}

function platformPurchaseLabel(run: PurchaseSnapshot): string {
    if (run.status === "unknown" || run.status === "interrupted") return "需要人工確認";
    if (run.status === "running") {
        const { title } = purchaseStatus(run, false, Date.now());
        return title === defaultRunningStatus.title ? "購票進行中" : title;
    }
    return run.browserOpen ? "瀏覽器仍開啟" : "等待程序結束";
}
