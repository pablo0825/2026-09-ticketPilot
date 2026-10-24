import type { TicketPlusWorkerEvent } from "../../../../shared/platforms/ticketplus/events.js";
import type { PurchaseSnapshot } from "../../../../shared/runSnapshot.js";
import { latestTicketPlusStage, purchaseStatus } from "./runStatus.js";

import type { RunStep } from "../../shared/runs/runStep.js";

import type { BadgeTone, RunStepsView as TicketPlusStepsView } from "../../shared/runs/runView.js";
export type { BadgeTone, RunStepsView as TicketPlusStepsView } from "../../shared/runs/runView.js";

type StepKey =
    | "launch"
    | "login"
    | "activity"
    | "sale"
    | "session"
    | "tickets"
    | "information"
    | "payment"
    | "participants"
    | "registration"
    | "confirm";

const stepLabels: Record<StepKey, string> = {
    launch: "啟動購票瀏覽器",
    login: "確認登入",
    activity: "開啟活動頁",
    sale: "等待開賣",
    session: "選擇場次",
    tickets: "選擇票種並送出",
    information: "送出購票資料",
    payment: "輪到你付款",
    participants: "填寫參加者",
    registration: "送出參加者資料",
    confirm: "輪到你確認登記",
};

// 每個程式階段對應到一個步驟；換順位、更新票數與排隊都留在選票步驟。
const stageSteps: Record<TicketPlusWorkerEvent["stage"], StepKey> = {
    starting: "launch",
    "checking-login": "login",
    "waiting-for-login": "login",
    "login-ready": "login",
    "opening-activity": "activity",
    "waiting-for-sale": "sale",
    "refreshing-activity": "sale",
    "waiting-for-availability": "sale",
    "selecting-session": "session",
    "selecting-tickets": "tickets",
    submitting: "tickets",
    queue: "tickets",
    "waiting-to-refresh": "tickets",
    refreshing: "tickets",
    "submitting-information": "information",
    "waiting-for-participants": "participants",
    "completing-registration": "registration",
};

// 只有記錄流程類型的 TicketPlus 執行才顯示步驟；其他情況回傳 undefined，畫面改用原本的紀錄。
export function ticketPlusStepsView(
    run: PurchaseSnapshot,
    closingBrowser: boolean,
    now: number,
): TicketPlusStepsView | undefined {
    if (run.platform !== "ticketplus" || !run.flowType) return undefined;

    // 依流程類型與開賣時間決定步驟，並找出目前走到哪一步。
    const keys = stepKeys(run.flowType, Boolean(run.saleAt));
    const current = currentStepIndex(run, keys);
    const latestStage = latestTicketPlusStage(run);

    // 計算每一步的狀態。
    const steps = keys.map((key): RunStep => ({ label: stepLabels[key], state: "pending" }));
    markSteps(run, steps, keys, current, latestStage);

    // 標題沿用既有狀態標題，說明改用較短的文字。
    const title = flowTitle(run, purchaseStatus(run, closingBrowser, now).title);
    return { title, badge: badge(run, latestStage), summary: summary(run, closingBrowser, now, latestStage), steps };
}

function stepKeys(flowType: NonNullable<PurchaseSnapshot["flowType"]>, hasSale: boolean): StepKey[] {
    const opening: StepKey[] = [
        "launch",
        "login",
        "activity",
        ...(hasSale ? ["sale" as const] : []),
        "session",
        "tickets",
    ];
    return flowType === "lottery"
        ? [...opening, "participants", "registration", "confirm"]
        : [...opening, "information", "payment"];
}

// 取目前走到最遠的步驟，晚到的舊階段不會讓步驟倒退。
function currentStepIndex(run: PurchaseSnapshot, keys: StepKey[]): number {
    let current = 0;
    for (const item of run.events) {
        if (item.event.type !== "ticketplus") continue;
        const index = keys.indexOf(stageSteps[item.event.stage]);
        if (index > current) current = index;
    }
    return current;
}

function markSteps(
    run: PurchaseSnapshot,
    steps: RunStep[],
    keys: StepKey[],
    current: number,
    latestStage: TicketPlusWorkerEvent["stage"] | undefined,
): void {
    const last = steps.length - 1;
    const markDoneBefore = (end: number) => {
        for (let index = 0; index < end; index++) steps[index]!.state = "done";
    };

    // 走到付款頁或確認登記前：前面全部完成，最後一步輪到使用者。
    if (run.status === "payment-ready" || run.status === "registration-ready") {
        markDoneBefore(last);
        steps[last] = { ...steps[last]!, state: "action", note: run.message };
        return;
    }

    // 停在資料頁：目前這步完成，下一步交給使用者確認。
    if (run.status === "information-ready") {
        const next = Math.min(current + 1, last);
        markDoneBefore(next);
        steps[next] = { ...steps[next]!, state: "action", note: run.message };
        return;
    }

    // 停止、失敗或結果未確認：標在目前這一步，之後的步驟未執行。
    if (run.status !== "running") {
        markDoneBefore(current);
        const state = run.status === "failed" ? (run.stopReason ? "stopped" : "failed") : "unknown";
        steps[current] = { ...steps[current]!, state, note: run.message };
        for (let index = current + 1; index < steps.length; index++) steps[index]!.state = "skipped";
        return;
    }

    // 執行中：等待使用者登入或填寫參加者時顯示輪到你，其餘轉圈。
    markDoneBefore(current);
    steps[current]!.state = "running";
    if (run.stopRequest) return;
    if (keys[current] === "login" && latestStage === "waiting-for-login") {
        steps[current] = { ...steps[current]!, state: "action", note: "請在購票瀏覽器手動登入，登入後會自動繼續。" };
    }
    if (keys[current] === "participants" && latestStage === "waiting-for-participants" && run.participantConfirmation) {
        steps[current] = {
            ...steps[current]!,
            state: "action",
            note: "請在購票瀏覽器填寫所有參加者，完成後按下方按鈕。",
            participantsButton: true,
        };
    }
}

// 抽選流程使用「登記」字眼。
function flowTitle(run: PurchaseSnapshot, title: string): string {
    if (run.flowType !== "lottery") return title;
    if (title === "正在購票") return "正在登記";
    if (title === "購票已停止") return "登記已停止";
    return title;
}

// 活動列表與執行狀態頁共用同一組狀態標籤文字。
export function ticketPlusRunBadge(run: PurchaseSnapshot): TicketPlusStepsView["badge"] {
    return badge(run, latestTicketPlusStage(run));
}

function badge(
    run: PurchaseSnapshot,
    latestStage: TicketPlusWorkerEvent["stage"] | undefined,
): TicketPlusStepsView["badge"] {
    if (run.status === "running") {
        if (run.stopRequest) return { text: "停止中", tone: "info" };
        if (latestStage === "waiting-for-login") return { text: "等待你", tone: "action" };
        if (latestStage === "waiting-for-participants" && run.participantConfirmation) {
            return { text: "等待你", tone: "action" };
        }
        return { text: "執行中", tone: "info" };
    }
    if (run.status === "payment-ready" || run.status === "registration-ready")
        return { text: "輪到你", tone: "action" };
    if (run.status === "information-ready") return { text: "請確認", tone: "unknown" };
    if (run.status === "failed")
        return run.stopReason ? { text: "已停止", tone: "neutral" } : { text: "失敗", tone: "error" };
    return { text: "請確認", tone: "unknown" };
}

function summary(
    run: PurchaseSnapshot,
    closingBrowser: boolean,
    now: number,
    latestStage: TicketPlusWorkerEvent["stage"] | undefined,
): string {
    if (closingBrowser) return "正在關閉購票瀏覽器，請稍候。";

    // 執行中依目前狀況提示。
    if (run.status === "running") {
        if (run.stopRequest) return purchaseStatus(run, closingBrowser, now).instruction;
        if (latestStage === "waiting-for-login") return "請在購票瀏覽器手動登入，登入後會自動繼續。";
        if (latestStage === "waiting-for-sale") return saleSummary(run.saleAt, now);
        if (latestStage === "waiting-for-participants") {
            return run.participantConfirmation
                ? "請在購票瀏覽器填完所有參加者，再按「參加者已填完」；網站倒數結束前須完成。"
                : "等待程式核對參加者並前往確認登記；如長時間沒有進展，請檢查購票瀏覽器或按停止。";
        }
        return "請勿操作購票瀏覽器。";
    }

    // 已結束：先說明結果，再提醒關閉瀏覽器。
    let ending = "";
    if (run.browserOpen) ending = "檢查完成後請關閉購票瀏覽器，才能開始下一場。";
    else if (run.occupied) ending = "尚未確認程序正常結束，請先檢查原瀏覽器及執行紀錄。";
    if (run.status === "payment-ready") {
        return run.browserOpen
            ? "請在購票瀏覽器核對金額並自行付款。" + ending
            : "購票瀏覽器已關閉；程式未核對付款結果，請自行確認訂單。" + ending;
    }
    if (run.status === "registration-ready") {
        return run.browserOpen
            ? "請檢查登記內容，再自行按「確認登記」；程式不會送出登記。" + ending
            : "購票瀏覽器已關閉；程式未送出登記，請自行確認登記狀態。" + ending;
    }
    if (run.status === "information-ready") return "請到購票瀏覽器確認目前頁面並人工接手。" + ending;
    if (run.status === "failed") {
        return (
            (run.stopReason ? "已停止自動操作，不會自動重新開始。" : "不會自動重新開始，請先確認購票瀏覽器的畫面。") +
            ending
        );
    }
    return "結果未確認，請到購票瀏覽器確認頁面與訂單；不會重送。" + ending;
}

function saleSummary(saleAtText: string | undefined, now: number): string {
    const saleAt = Date.parse(saleAtText ?? "");
    if (!Number.isFinite(saleAt)) return "開賣前會自動刷新，請勿操作購票瀏覽器。";
    const seconds = Math.max(0, Math.ceil((saleAt - now) / 1000));
    return seconds > 0
        ? `距開賣 ${seconds} 秒，開賣前會自動刷新。請勿操作購票瀏覽器。`
        : "已到開賣時間，等待程式更新進度。";
}
