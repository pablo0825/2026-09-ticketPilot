import type { TicketPlusWorkerEvent } from "../../../purchaseEvents.js";
import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";

import {
    stopRequestPresentation,
    defaultRunningStatus,
    stateRunningStatus,
    finishedStatus,
} from "../../shared/runs/commonPresentation.js";
import type { RunStatusText } from "../../shared/runs/commonPresentation.js";
type TicketPlusStage = TicketPlusWorkerEvent["stage"];
type FixedTicketPlusStage = Exclude<TicketPlusStage, "waiting-for-sale" | "waiting-for-participants">;

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
