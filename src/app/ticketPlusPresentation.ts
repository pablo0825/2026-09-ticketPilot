import type { TicketPlusRunEvent, TicketPlusRunResult } from "./runTicketPlus.js";
import type { SessionEntryReason, SessionEntryStage } from "../platforms/ticketplus/sessionSelection.js";

const sessionReasons: Record<SessionEntryReason, string> = {
    "invalid-settings": "活動設定無效，請檢查活動網址、名稱及場次日期時間",
    "invalid-options": "場次操作的等待時間設定無效",
    "unexpected-page": "目前頁面不是可辨識的預期頁面，請確認登入狀態、活動頁及是否有彈窗",
    "activity-mismatch": "頁面活動名稱或活動 ID 與設定不符，請核對 eventName 與 eventUrl",
    "session-missing": "找不到符合日期與時間的場次，請核對 該順位的日期與時間",
    "session-ambiguous": "同日期與時間有多個場次，無法唯一選擇，請人工確認",
    "session-disabled": "目標場次的立即購買按鈕目前停用，請查看網站狀態；不能僅據此判定尚未開賣或已售完",
    "session-changed": "點擊前場次資料已改變，請重新核對頁面",
    "button-unavailable": "無法唯一定位可用的立即購買按鈕，請檢查頁面是否已變動",
    "click-failed": "立即購買的點擊結果未確認，請檢查目前頁面",
    "arrival-mismatch": "進入的選票頁與設定活動或場次不符，請核對活動及日期時間",
    "arrival-timeout": "等待選票頁逾時，請檢查目前是否仍在處理或已完成跳轉",
    "read-failed": "無法完成頁面資料讀取，請檢查瀏覽器是否關閉、頁面載入或變動",
};

export function ticketPlusSessionMessage(failure: { reason: SessionEntryReason; stage: SessionEntryStage }): string {
    const attempt =
        failure.stage === "before-click"
            ? "尚未嘗試點擊立即購買"
            : "已嘗試點擊立即購買，請先人工確認目前頁面，不會再次點擊";
    return `場次選擇停止（${failure.reason}）：${sessionReasons[failure.reason]}。${attempt}；尚未嘗試選票提交，不會自動重跑。`;
}

export function ticketPlusResultMessage(result: TicketPlusRunResult): string {
    if (result.outcome === "information-ready")
        return "已到同場次填寫資料頁，本階段完成。請人工接手；未填資料、未勾條款、未操作付款。";
    if (result.stopReason === "user-stop") {
        if (result.outcome === "unknown")
            return "已依要求停止自動操作；已嘗試提交，結果未確認。請檢查原頁面及訂單，不會重送。";
        if (result.outcome === "rejected")
            return "已依要求停止自動操作；已確認購票失敗，請人工檢查彈窗與頁面，不會繼續關閉或重試。";
        return "已依要求停止自動操作，尚未嘗試選票提交。瀏覽器保留供人工檢查，關閉後才解除購票占用。";
    }
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
    if ("sessionFailure" in result && result.sessionFailure) return ticketPlusSessionMessage(result.sessionFailure);
    if ("priorityFailure" in result && result.priorityFailure) {
        const detail =
            result.priorityFailure === "all-targets-sold-out"
                ? "本次檢查的設定順位皆明確售完"
                : `順位核對未通過（${result.priorityFailure}），不能據此判定售完`;
        return `${detail}。尚未提交，不刷新或重跑。`;
    }
    return `流程已停止（${result.reason}），尚未嘗試選票提交。請檢查購票瀏覽器；不會自動重跑。`;
}
export function ticketPlusEventMessage(event: TicketPlusRunEvent): string | undefined {
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
