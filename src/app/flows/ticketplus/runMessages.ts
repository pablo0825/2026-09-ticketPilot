import type { TicketPlusSaleReason } from "../../../platforms/ticketplus/salePreparation.js";
import type { TicketPlusRunEvent, TicketPlusRunResult, TicketPlusStage } from "./runTicketPlus.js";
import type {
    SessionDiagnostic,
    SessionEntryReason,
    SessionEntryStage,
} from "../../../platforms/ticketplus/sessionSelection.js";
import type { TicketPlusStopReason } from "../../../platforms/ticketplus/runControl.js";
import type { Dismissal, SubmissionProgress } from "../../../platforms/ticketplus/ticketSubmission.js";
import type { TicketRefreshResult } from "../../../platforms/ticketplus/ticketRefresh.js";
import type { ReselectionBlockedReason } from "../../../platforms/ticketplus/reselectionReadiness.js";
import type { InformationSubmissionReason } from "../../../platforms/ticketplus/informationSubmission.js";
import type { LotteryFailure } from "./finishLottery.js";
import type { TicketPlusLoginReason } from "../../../platforms/ticketplus/loginWait.js";
import type { PriorityReason } from "../../../platforms/ticketplus/ticketPriority.js";

const sessionReasons: Record<SessionEntryReason, string> = {
    "activity-ready-timeout": "等待活動頁載入逾時，尚未取得完整場次",
    "invalid-settings": "活動設定無效，請檢查活動網址、名稱及場次日期時間",
    "invalid-options": "場次操作的等待時間設定無效",
    "unexpected-page": "目前頁面不是可辨識的預期頁面，請確認登入狀態、活動頁及是否有彈窗",
    "activity-mismatch": "頁面活動名稱或活動 ID 與設定不符，請核對活動名稱與活動網址",
    "session-date-mismatch": "目標場次日期與設定不符",
    "session-time-mismatch": "目標場次時間與設定不符",
    "session-time-invalid": "目標場次使用時間範圍，目前只接受單一時間",
    "session-missing": "活動頁場次已載入完成，但找不到符合設定名稱的場次，請核對活動名稱",
    "session-ambiguous": "目標場次名稱或欄位不唯一，請人工確認",
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

const loginReasons: Record<TicketPlusLoginReason, string> = {
    "page-timeout": "首頁載入逾時",
    "login-timeout": "等待登入逾時",
    "sale-expired": "已超過開賣後的等待期限",
    "page-closed": "購票頁已關閉",
    "page-crashed": "購票頁異常中斷",
    "read-timeout": "讀取登入狀態逾時",
    "read-failed": "無法讀取登入狀態",
    "unexpected-route": "目前頁面不是預期的 TicketPlus 頁面",
    "menu-failed": "無法開啟會員選單確認登入",
};

const priorityReasons: Record<Exclude<PriorityReason, "all-targets-sold-out">, string> = {
    "invalid-options": "選票的等待時間設定無效",
    "unexpected-page": "目前頁面不是可辨識的選票頁",
    "identity-mismatch": "選票頁的活動或場次與設定不符",
    "ticket-missing": "找不到設定的票種",
    "ticket-ambiguous": "設定的票種不唯一，請人工確認",
    "extra-tickets": "頁面上已有其他票種被選取",
    "area-expansion-failed": "票區展開後找不到唯一的票種",
    "operation-timeout": "選票操作逾時",
};

// 使用者停止與時間上限由 stopLeads 說明，這裡只列其他原因。
const lotteryReasons: Record<Exclude<LotteryFailure, "time-limit" | "user-stopped">, string> = {
    "not-input-page": "目前不在輸入資料頁",
    "dialog-open": "頁面有尚未關閉的彈窗",
    "participant-count": "參加者人數與張數不符",
    "participant-incomplete": "參加者資料尚未填完",
    "terms-missing": "找不到服務條款勾選框",
    "terms-unchecked": "服務條款勾選未確認",
    "next-unavailable": "下一步按鈕無法使用",
    "checkout-not-reached": "未能確認到達確認登記頁",
    "read-failed": "無法讀取頁面",
    "participant-page-changed": "頁面已離開輸入資料頁（可能是網站倒數結束）",
    "confirmation-failed": "「參加者已填完」的確認未能送達",
};

const informationReasons: Record<Exclude<InformationSubmissionReason, "time-limit" | "user-stopped">, string> = {
    "not-purchase-page": "目前不在填寫資料頁",
    "terms-missing": "找不到服務條款勾選框",
    "terms-unchecked": "服務條款勾選未確認",
    "next-unavailable": "下一步按鈕無法使用",
    "checkout-not-reached": "未能確認到達付款頁",
    "read-failed": "無法讀取頁面",
};

const stopLeads: Record<TicketPlusStopReason, string> = {
    "time-limit": "已達最長執行時間，停止自動操作",
    "user-stop": "已依要求停止自動操作",
};

const dismissalLabels: Record<Dismissal, string> = {
    confirmed: "彈窗已確認關閉",
    disappeared: "彈窗已消失，未嘗試關閉",
    unconfirmed: "彈窗關閉未確認",
    "not-attempted": "彈窗關閉未確認",
};

const stageMessages: Record<TicketPlusStage, string> = {
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
    "waiting-for-participants": "已到輸入資料頁，請在購票瀏覽器填寫所有參加者，完成後在 GUI 按「參加者已填完」。",
    "completing-registration": "核對參加者已填，勾選服務條款並按一次下一步，等待確認登記頁。",
    "waiting-to-refresh": "本輪設定順位已耗盡，短暫等待後核對更新票數；可要求停止。",
    refreshing: "核對並嘗試一次更新票數；更新完成未確認前不開始新一輪。",
};

// initial 是每輪開始的正常重設，不需要顯示。
const attemptResetMessages: Record<"initial" | "next-priority" | "refreshed", string | undefined> = {
    initial: undefined,
    "next-priority": "前次提交已確認售完且重新選票核對通過，檢查本輪剩餘順位。",
    refreshed: "更新完成，從第一順位重新檢查。",
};

// 給使用者看的場次停止原因；診斷資料由 ticketPlusSessionDiagnostic 另外提供。
export function ticketPlusSessionMessage(failure: { reason: SessionEntryReason; stage: SessionEntryStage }): string {
    const attempt =
        failure.stage === "before-click"
            ? "尚未嘗試點擊場次按鈕"
            : "已嘗試點擊場次按鈕，請先人工確認目前頁面，不會再次點擊";
    return `場次選擇停止：${sessionReasons[failure.reason]}。${attempt}；尚未嘗試選票提交，不會自動重跑。`;
}

export function ticketPlusSessionDiagnostic(failure: {
    stage: SessionEntryStage;
    diagnostic?: SessionDiagnostic;
}): string | undefined {
    if (!failure.diagnostic) return undefined;
    return `場次診斷（${failure.stage}；最後一次觀測）：${JSON.stringify(failure.diagnostic)}`;
}

// 給使用者看的結果說明，不含診斷資料。
export function ticketPlusResultMessage(result: TicketPlusRunResult): string {
    return resultMessage(result);
}

// 給開發者看的診斷資料；沒有診斷時回傳 undefined。
export function ticketPlusResultDiagnostic(result: TicketPlusRunResult): string | undefined {
    const parts: string[] = [];

    // 停止原因代碼，供開發者對照程式分支。
    const codes = stopCodes(result);
    if (codes) parts.push(codes);

    // 登入停止時的觀測摘要。
    if (result.loginDiagnostic) {
        parts.push(`登入停止診斷：${JSON.stringify(result.loginDiagnostic)}`);
    } else if ("loginFailure" in result && result.loginFailure) {
        parts.push(`登入核對診斷：${JSON.stringify(result.loginFailure.summary)}`);
    }

    // 場次選擇停止時的最後一次觀測。
    if ("sessionFailure" in result && result.sessionFailure) {
        const session = ticketPlusSessionDiagnostic(result.sessionFailure);
        if (session) parts.push(session);
    }

    // 選票提交後停止的原因與觀測。
    const submission = postSubmitDetail(result);
    if (submission) parts.push(submission);

    return parts.length > 0 ? parts.join(" ") : undefined;
}

function stopCodes(result: TicketPlusRunResult): string | undefined {
    if (!("reason" in result)) return undefined;
    const codes: Record<string, unknown> = { reason: result.reason };

    // 各階段的細部原因代碼。
    if ("priorityFailure" in result && result.priorityFailure) codes.priorityFailure = result.priorityFailure;
    if ("saleFailure" in result && result.saleFailure) codes.saleFailure = result.saleFailure;
    if ("noticeFailure" in result && result.noticeFailure) codes.noticeFailure = result.noticeFailure;
    if ("lotteryFailure" in result) codes.lotteryFailure = result.lotteryFailure;
    if ("informationFailure" in result) codes.informationFailure = result.informationFailure;
    if ("reselectionFailure" in result && result.reselectionFailure) {
        codes.reselectionFailure = result.reselectionFailure;
    }
    if ("activityLoginFailure" in result && result.activityLoginFailure) {
        codes.activityLoginFailure = result.activityLoginFailure;
    }

    // 登入、場次與更新票數的原因放在各自的物件裡。
    if ("loginFailure" in result && result.loginFailure) codes.loginFailure = result.loginFailure.reason;
    if ("sessionFailure" in result && result.sessionFailure) {
        codes.sessionFailure = `${result.sessionFailure.reason}／${result.sessionFailure.stage}`;
    }
    if ("refresh" in result && result.refresh?.kind === "stopped") codes.refresh = result.refresh.reason;
    return `停止代碼：${JSON.stringify(codes)}`;
}

// 只有選票提交後停止才補充原因；資料頁與抽選結果已在主訊息說明。
function postSubmitDetail(result: TicketPlusRunResult): string | undefined {
    if (!result.progress.submitAttempted || result.outcome === "information-ready" || !("reason" in result)) {
        return undefined;
    }
    if (result.reason === "information-stopped" || result.reason === "lottery-stopped") {
        return undefined;
    }

    const diagnostic =
        "diagnostic" in result && result.diagnostic
            ? ` 診斷（最後一次觀測）：${JSON.stringify(result.diagnostic)}`
            : "";
    return `提交後停止原因：${result.reason}。${diagnostic}`;
}

function resultMessage(result: TicketPlusRunResult): string {
    // 抽選、資料頁與到達資料頁各有獨立訊息，先分派出去。
    if (result.outcome === "registration-ready") {
        return "已停在確認登記前，已勾選服務條款並按一次下一步。請自行檢查登記內容並按確認登記；程式不會送出登記。";
    }
    if ("lotteryFailure" in result) return lotteryStoppedMessage(result);

    if (result.outcome === "payment-ready") {
        return "已到同場次付款頁，已勾選服務條款並送出資料頁一次。請自行確認金額、選擇付款方式並付款；程式不會按前往付款。";
    }
    if ("informationFailure" in result) return informationStoppedMessage(result);
    if (result.outcome === "information-ready") {
        return "已到同場次填寫資料頁，本階段完成。請人工接手；未填資料、未勾條款、未操作付款。";
    }

    // 其餘為選票流程，先整理先前提交次數的說明。
    const prior = priorSubmissionText(result);

    // 使用者停止或逾時優先顯示，即使同時有選位或提交原因。
    if (result.stopReason) return controlStopMessage(result.stopReason, result.outcome, prior);

    // 選位與提交結果。
    if (result.reason === "seat-mismatch") {
        return "選位結果與設定的票區或張數不符，已停止；座位仍在網站保留中，請自行取消或處理。不會重試。";
    }
    if (result.reason === "seat-button-unavailable") {
        return "確認選位結果頁的下一步無法使用，已停止；座位仍在網站保留中，請自行處理。不會重試。";
    }
    if (result.reason === "seat-confirm-unconfirmed") {
        return "已確認選位，但未能確認抵達資料頁，請檢查瀏覽器，不會重試。";
    }
    if (result.outcome === "unknown") return "已嘗試提交，結果未確認。請檢查原頁面及訂單；不會重送。";
    if (result.outcome === "rejected") return rejectedMessage(result);

    // 刷新與選票前各階段停止。
    if ("refresh" in result && result.refresh) return refreshMessage(result.refresh, prior);
    if ("loginFailure" in result && result.loginFailure) {
        return `登入核對停止：${loginReasons[result.loginFailure.reason]}。尚未選票或提交，不會自動重跑。`;
    }
    if ("sessionFailure" in result && result.sessionFailure) return ticketPlusSessionMessage(result.sessionFailure);
    if ("priorityFailure" in result && result.priorityFailure) {
        const detail =
            result.priorityFailure === "all-targets-sold-out"
                ? "本次檢查的設定順位皆已售完或暫無票券"
                : `順位核對未通過：${priorityReasons[result.priorityFailure]}，不能據此判定售完`;
        return `${detail}。${prior}不刷新或重跑。`;
    }
    if (result.reason === "sale-wait-stopped") {
        const detail = "saleFailure" in result && result.saleFailure ? saleReasons[result.saleFailure] : "等待已中斷";
        return `開賣等待停止：${detail}。尚未選場次或提交選票，請檢查購票瀏覽器；不會自動重跑。`;
    }
    if ("noticeFailure" in result && result.noticeFailure) {
        return "活動頁提醒彈窗無法確認關閉，尚未選場次或提交選票，請檢查購票瀏覽器；不會自動重跑。";
    }
    if ("activityLoginFailure" in result && result.activityLoginFailure) {
        return "開啟活動頁後無法確認登入狀態，尚未選場次或提交選票。請在購票瀏覽器確認已登入；不會自動重跑。";
    }

    return `流程已停止。${prior}請檢查購票瀏覽器；不會自動重跑。`;
}

function lotteryStoppedMessage(result: {
    outcome: "stopped" | "unknown";
    lotteryFailure: LotteryFailure;
    stopReason?: TicketPlusStopReason;
}): string {
    if (result.outcome === "unknown") {
        return "已在輸入資料頁按下一步，但未能確認抵達確認登記頁。請檢查購票瀏覽器；不會重按或送出登記。";
    }

    const tail = "未送出登記。請檢查購票瀏覽器；不會自動重跑。";
    if (result.stopReason) return `${stopLeads[result.stopReason]}：${tail}`;
    if (result.lotteryFailure === "time-limit" || result.lotteryFailure === "user-stopped") {
        return `登記送出前停止：${tail}`;
    }
    return `登記送出前停止：${lotteryReasons[result.lotteryFailure]}。${tail}`;
}

function informationStoppedMessage(result: {
    outcome: "stopped" | "unknown";
    informationFailure: InformationSubmissionReason;
    stopReason?: TicketPlusStopReason;
}): string {
    if (result.outcome === "unknown") {
        return "已在資料頁按下一步，但未能確認抵達付款頁。請檢查購票瀏覽器；不會重按或重新購票。";
    }

    const tail = "已保留在資料頁、未送出。請檢查購票瀏覽器；不會自動重跑。";
    if (result.stopReason) return `${stopLeads[result.stopReason]}：${tail}`;
    if (result.informationFailure === "time-limit" || result.informationFailure === "user-stopped") {
        return `資料頁送出前停止：${tail}`;
    }
    return `資料頁送出前停止：${informationReasons[result.informationFailure]}。${tail}`;
}

function priorSubmissionText(result: TicketPlusRunResult): string {
    const attempts = "submissionAttempts" in result ? result.submissionAttempts : 0;
    if (attempts > 0 && !result.progress.submitAttempted) {
        return `先前 ${attempts} 次提交已確認售完，目前未開始下一次提交。`;
    }
    return "尚未嘗試選票提交。";
}

function controlStopMessage(
    stopReason: TicketPlusStopReason,
    outcome: TicketPlusRunResult["outcome"],
    prior: string,
): string {
    const lead = stopLeads[stopReason];
    if (outcome === "unknown") return `${lead}；已嘗試提交，結果未確認。請檢查原頁面及訂單，不會重送。`;
    if (outcome === "rejected") {
        return `${lead}；已確認購票失敗，請人工檢查彈窗與頁面。程式不會再處理彈窗或重試。`;
    }
    return `${lead}。${prior}瀏覽器保留供人工檢查，關閉後才解除購票占用。`;
}

function rejectedMessage(result: {
    progress: Readonly<SubmissionProgress>;
    reselectionFailure?: ReselectionBlockedReason;
}): string {
    const reason = result.progress.failure === "sold-out" ? "已售完" : "購票失敗";
    const dismissal = dismissalLabels[result.progress.dismissal];
    if (result.reselectionFailure) {
        return `${reason}，${dismissal}。重新選票前的頁面核對未通過，無法安全改選下一順位，流程停止；不刷新、不重送。`;
    }
    return `${reason}，${dismissal}。流程停止，不刷新、不切換候補。`;
}

function refreshMessage(refresh: TicketRefreshResult, prior: string): string {
    if (refresh.kind === "completed") {
        return `選票頁更新完成並核對通過。${prior}未設定全程執行期限（最長執行時間），為避免無限重試而停止，不開始新一輪；瀏覽器保留供人工檢查。`;
    }

    const action = refresh.clickAttempted ? "已嘗試一次更新票數" : "尚未嘗試更新票數";
    const detail = refresh.reason === "completion-unverified" ? "尚無可靠訊號確認更新完成" : "更新票數時頁面核對未通過";
    return `${action}，${detail}。${prior}不補按、不開始新一輪選票，請人工檢查。`;
}

export function ticketPlusEventMessage(event: TicketPlusRunEvent): string | undefined {
    // 依事件類型對應訊息；其餘為提交進度事件。
    if (event.type === "stage") return stageMessages[event.stage];
    if (event.type === "login-observation") return `登入狀態觀測變化：${JSON.stringify(event.summary)}`;
    if (event.type === "login-stopped") return `登入等待停止：${JSON.stringify(event.summary)}`;
    if (event.type === "login-wait") return `登入核對等待：${event.elapsedMs} 毫秒，共觀測 ${event.observations} 次。`;
    if (event.type === "activity-wait") {
        return `活動頁核對等待：${event.elapsedMs} 毫秒，共觀測 ${event.observations} 次。`;
    }
    if (event.type === "lease-release-failed") return "無法釋放購票占用，請人工檢查；不會自動解除。";
    if (event.type === "attempt-reset") return attemptResetMessages[event.reason];
    if (event.type === "participants-wait") return undefined;
    return submissionProgressMessage(event.progress);
}

function submissionProgressMessage(progress: Readonly<SubmissionProgress>): string | undefined {
    if (progress.failure === "sold-out") return "偵測到明確售完，處理彈窗後核對是否可以嘗試下一順位。";
    if (progress.failure) return "偵測到購票失敗，完成彈窗處理後停止。";
    if (progress.sawQueue) return "排隊中，等待網站處理，不重送。";
    if (progress.submitAttempted) return "已開始一次提交嘗試，結果尚待確認。";
    return undefined;
}
