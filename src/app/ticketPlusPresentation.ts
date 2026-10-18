import type { TicketPlusSaleReason } from "../platforms/ticketplus/salePreparation.js";
import type { TicketPlusRunEvent, TicketPlusRunResult } from "./runTicketPlus.js";
import type {
    SessionDiagnostic,
    SessionEntryReason,
    SessionEntryStage,
} from "../platforms/ticketplus/sessionSelection.js";

const sessionReasons: Record<SessionEntryReason, string> = {
    "activity-ready-timeout": "等待活動頁載入逾時，尚未取得完整場次",
    "invalid-settings": "活動設定無效，請檢查活動網址、名稱及場次日期時間",
    "invalid-options": "場次操作的等待時間設定無效",
    "unexpected-page": "目前頁面不是可辨識的預期頁面，請確認登入狀態、活動頁及是否有彈窗",
    "activity-mismatch": "頁面活動名稱或活動 ID 與設定不符，請核對 eventName 與 eventUrl",
    "session-missing": "找不到符合日期與時間的場次，請核對 該順位的日期與時間",
    "session-ambiguous": "同日期與時間有多個場次，無法唯一選擇，請人工確認",
    "not-on-sale": "目標場次尚未開賣，尚未嘗試點擊場次按鈕",
    "session-disabled":
        "目標場次的場次按鈕（立即購買／立即登記）目前停用，請查看網站狀態；不能僅據此判定尚未開賣或已售完",
    "session-changed": "點擊前場次資料已改變，請重新核對頁面",
    "button-unavailable": "無法唯一定位可用的場次按鈕（立即購買／立即登記），請檢查頁面是否已變動",
    "click-failed": "場次按鈕的點擊結果未確認，請檢查目前頁面",
    "arrival-mismatch": "進入的選票頁與設定活動或場次不符，請核對活動及日期時間",
    "arrival-timeout": "等待選票頁逾時，請檢查目前是否仍在處理或已完成跳轉",
    "read-failed": "無法完成頁面資料讀取，請檢查瀏覽器是否關閉、頁面載入或變動",
    "notice-dismiss-failed": "活動頁提醒彈窗無法確認關閉，請檢查頁面",
    "flow-mismatch": "場次按鈕與設定的流程類型不符（購票為立即購買、登記抽選為立即登記），請檢查活動設定的購票流程",
};

const saleReasons: Record<TicketPlusSaleReason, string> = {
    "invalid-schedule": "開賣時間或提前刷新秒數無效",
    "invalid-clock": "無法核對目前時間",
    "sale-expired": "已超過開賣後 2 分鐘的等待期限",
    "page-closed": "購票頁已關閉或中斷",
    "unexpected-page": "目前網址不是設定的活動頁",
    "activity-mismatch": "活動名稱或 ID 與設定不符",
    "session-missing": "找不到設定的日期與時間",
    "session-ambiguous": "同日期與時間有多個場次",
    "session-disabled": "目標的場次按鈕停用，不能據此判定尚未開賣",
    "page-unrecognized": "無法確認頁面或場次狀態",
    "read-timeout": "等待活動頁資料完整逾時",
    "refresh-failed": "活動頁刷新未確認成功",
    "notice-dismiss-failed": "活動頁提醒彈窗無法確認關閉",
};

export function ticketPlusSessionMessage(failure: {
    reason: SessionEntryReason;
    stage: SessionEntryStage;
    diagnostic?: SessionDiagnostic;
}): string {
    const attempt =
        failure.stage === "before-click"
            ? "尚未嘗試點擊場次按鈕"
            : "已嘗試點擊場次按鈕，請先人工確認目前頁面，不會再次點擊";
    const diagnostic = failure.diagnostic
        ? ` 診斷（${failure.stage}；最後一次觀測）：${JSON.stringify(failure.diagnostic)}`
        : "";
    return `場次選擇停止（${failure.reason}）：${sessionReasons[failure.reason]}。${attempt}；尚未嘗試選票提交，不會自動重跑。${diagnostic}`;
}

export function ticketPlusResultMessage(result: TicketPlusRunResult): string {
    const base = resultMessage(result);
    const message = result.loginDiagnostic ? `${base} 登入停止診斷：${JSON.stringify(result.loginDiagnostic)}` : base;
    if (!result.progress.submitAttempted || result.outcome === "information-ready" || !("reason" in result))
        return message;
    const diagnostic = "diagnostic" in result ? result.diagnostic : undefined;
    return `${message} 提交後停止原因：${result.reason}。${diagnostic ? ` 診斷（最後一次觀測）：${JSON.stringify(diagnostic)}` : ""}`;
}

function resultMessage(result: TicketPlusRunResult): string {
    if (result.outcome === "payment-ready") {
        return "已到同場次付款頁，已勾選服務條款並送出資料頁一次。請自行確認金額、選擇付款方式並付款；程式不會按前往付款。";
    }
    if ("informationFailure" in result && result.outcome === "stopped" && !result.stopReason) {
        return `資料頁送出前停止（${result.informationFailure}）：已保留在資料頁、未送出。請檢查購票瀏覽器；不會自動重跑。`;
    }
    if ("informationFailure" in result && result.outcome === "unknown") {
        return "已在資料頁按下一步，但未能確認抵達付款頁。請檢查購票瀏覽器；不會重按或重新購票。";
    }
    if (result.outcome === "information-ready")
        return "已到同場次填寫資料頁，本階段完成。請人工接手；未填資料、未勾條款、未操作付款。";
    const priorAttempts = "submissionAttempts" in result ? result.submissionAttempts : 0;
    const prior =
        priorAttempts > 0 && !result.progress.submitAttempted
            ? `先前 ${priorAttempts} 次提交已確認售完，目前未開始下一次提交。`
            : "尚未嘗試選票提交。";
    if (result.stopReason === "time-limit") {
        if (result.outcome === "unknown")
            return "已達最長執行時間，停止自動操作；已嘗試提交，結果未確認。請檢查原頁面及訂單，不會重送。";
        if (result.outcome === "rejected")
            return "已達最長執行時間，停止自動操作；已確認購票失敗，請人工檢查彈窗與頁面，不會繼續關閉或重試。";
        return `已達最長執行時間，停止自動操作。${prior}瀏覽器保留供人工檢查，關閉後才解除購票占用。`;
    }
    if (result.stopReason === "user-stop") {
        if (result.outcome === "unknown")
            return "已依要求停止自動操作；已嘗試提交，結果未確認。請檢查原頁面及訂單，不會重送。";
        if (result.outcome === "rejected")
            return "已依要求停止自動操作；已確認購票失敗，請人工檢查彈窗與頁面，不會繼續關閉或重試。";
        return `已依要求停止自動操作。${prior}瀏覽器保留供人工檢查，關閉後才解除購票占用。`;
    }
    if ("reason" in result && result.reason === "seat-mismatch") {
        return "選位結果與設定的票區或張數不符，已停止；座位仍在網站保留中，請自行取消或處理。不會重試。";
    }
    if ("reason" in result && result.reason === "seat-button-unavailable") {
        return "確認選位結果頁的下一步無法使用，已停止；座位仍在網站保留中，請自行處理。不會重試。";
    }
    if ("reason" in result && result.reason === "seat-confirm-unconfirmed") {
        return "已確認選位，但未能確認抵達資料頁，請檢查瀏覽器，不會重試。";
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
        const blocked =
            "reselectionFailure" in result && result.reselectionFailure
                ? `重新選票前核對未通過（${result.reselectionFailure}）。`
                : "";
        return `${reason}，${dismissal}。${blocked}流程停止，不刷新、不切換候補。`;
    }
    if ("refresh" in result && result.refresh) {
        const refresh = result.refresh;
        if (refresh.kind === "completed") {
            return `選票頁更新完成並核對通過。${prior}未設定全程執行期限，停止自動操作，不開始新一輪；瀏覽器保留供人工檢查。`;
        }
        const action = refresh.clickAttempted ? "已嘗試一次更新票數" : "尚未嘗試更新票數";
        const detail =
            refresh.reason === "completion-unverified"
                ? "尚無可靠訊號確認更新完成"
                : `更新核對停止（${refresh.reason}）`;
        return `${action}，${detail}。${prior}不補按、不開始新一輪選票，請人工檢查。`;
    }
    if ("loginFailure" in result && result.loginFailure)
        return `登入核對停止（${result.loginFailure.reason}）；尚未選票或提交。${result.loginDiagnostic ? "" : `診斷：${JSON.stringify(result.loginFailure.summary)}`}`;
    if ("sessionFailure" in result && result.sessionFailure) return ticketPlusSessionMessage(result.sessionFailure);
    if ("priorityFailure" in result && result.priorityFailure) {
        const detail =
            result.priorityFailure === "all-targets-sold-out"
                ? "本次檢查的設定順位皆已售完或暫無票券"
                : `順位核對未通過（${result.priorityFailure}），不能據此判定售完`;
        return `${detail}。${prior}不刷新或重跑。`;
    }
    if (result.reason === "sale-wait-stopped") {
        const detail = "saleFailure" in result && result.saleFailure ? saleReasons[result.saleFailure] : "等待已中斷";
        return `開賣等待停止：${detail}。尚未選場次或提交選票，請檢查購票瀏覽器；不會自動重跑。`;
    }
    if ("noticeFailure" in result && result.noticeFailure) {
        return "活動頁提醒彈窗無法確認關閉，尚未選場次或提交選票，請檢查購票瀏覽器；不會自動重跑。";
    }
    return `流程已停止（${result.reason}）。${prior}請檢查購票瀏覽器；不會自動重跑。`;
}
export function ticketPlusEventMessage(event: TicketPlusRunEvent): string | undefined {
    if (event.type === "login-observation" || event.type === "login-stopped") {
        const label = event.type === "login-observation" ? "登入狀態觀測變化" : "登入等待停止";
        return `${label}：${JSON.stringify(event.summary)}`;
    }
    if (event.type === "login-wait") return `登入核對等待：${event.elapsedMs} 毫秒，共觀測 ${event.observations} 次。`;
    if (event.type === "activity-wait")
        return `活動頁核對等待：${event.elapsedMs} 毫秒，共觀測 ${event.observations} 次。`;
    if (event.type === "lease-release-failed") return "無法釋放購票占用，請人工檢查；不會自動解除。";
    if (event.type === "attempt-reset") {
        if (event.reason === "refreshed") return "更新完成，從第一順位重新檢查。";
        return event.reason === "next-priority"
            ? "前次提交已確認售完且重新選票核對通過，檢查本輪剩餘順位。"
            : undefined;
    }
    if (event.type === "stage") {
        return {
            starting: "啟動 TicketPlus 購票瀏覽器。",
            "checking-login": "等待首頁會員區載入並確認登入狀態。",
            "opening-activity": "登入已確認，前往設定活動頁。",
            "waiting-for-login": "請在購票瀏覽器手動登入，成功後會自動繼續。",
            "waiting-for-sale": "等待指定開賣時間及提前刷新時間。",
            "refreshing-activity": "刷新活動頁並重新核對目標場次。",
            "waiting-for-availability": "目標場次尚未開賣，間隔至少 3 秒再次刷新；最多等到開賣後 2 分鐘。",
            "selecting-session": "核對活動並選擇場次。",
            "selecting-tickets": "核對票種並調整張數。",
            submitting: "核對選票並提交，等待資料頁。",
            "submitting-information": "已到資料頁，勾選服務條款並按一次下一步，等待付款頁。",
            "waiting-to-refresh": "本輪設定順位已耗盡，短暫等待後核對更新票數；可要求停止。",
            refreshing: "核對並嘗試一次更新票數；更新完成未確認前不開始新一輪。",
        }[event.stage];
    }
    if (event.progress.failure === "sold-out") return "偵測到明確售完，處理彈窗後核對是否可以嘗試下一順位。";
    if (event.progress.failure) return "偵測到購票失敗，完成彈窗處理後停止。";
    if (event.progress.sawQueue) return "排隊中，等待網站處理，不重送。";
    if (event.progress.submitAttempted) return "已開始一次提交嘗試，結果尚待確認。";
}
