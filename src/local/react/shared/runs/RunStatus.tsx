import { primaryButton, secondaryButton, panel, stepPanel, badgeColors } from "../styles.js";
import { useEffect, useRef, useState } from "react";
import type { DisplayedRun } from "./useRunStatus.js";
import { eventLogs, purchaseStatus, stopRequestPresentation } from "./runPresentation.js";
import type { StopRequestStatus } from "./runPresentation.js";
import { ticketPlusStepsView } from "./ticketPlusSteps.js";
import type { TicketPlusStepsView } from "./ticketPlusSteps.js";
import { RunSteps } from "./RunSteps.js";

interface Props {
    displayed: DisplayedRun | null;
    attached?: boolean;
    canClose: boolean;
    closing: boolean;
    onClose: () => void;
    onCopy: (text: string) => void;
    stopControl?: { available: boolean; progress?: StopRequestStatus; onStop: () => void };
    participantsControl?: { onConfirm: () => void };
}

export function RunStatus({
    displayed,
    attached = false,
    canClose,
    closing,
    onClose,
    onCopy,
    stopControl,
    participantsControl,
}: Props) {
    const [now, setNow] = useState(Date.now());
    const logElement = useRef<HTMLPreElement>(null);
    const followLog = useRef(true);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    let title = "尚未執行";
    let instruction = "請在第三步確認設定並開始。";
    let logs = "尚無紀錄。";
    let stepsView: TicketPlusStepsView | undefined;
    if (displayed?.kind === "purchase") {
        const run = displayed.run;
        ({ title, instruction } = purchaseStatus(run, closing, now));

        // 有流程類型的 TicketPlus 執行改用步驟清單與較短的說明。
        stepsView = ticketPlusStepsView(run, closing, now);
        if (stepsView) ({ title, summary: instruction } = stepsView);

        // 畫面送出的停止要求優先於階段提示。
        if (run.platform === "ticketplus" && run.status === "running" && stopControl?.progress) {
            ({ title, instruction } = stopRequestPresentation(stopControl.progress));
            if (stepsView) stepsView = { ...stepsView, badge: { text: "停止中", tone: "info" } };
        }
        const recordedAt = run.events[0]?.at;
        logs =
            `購票平台：${run.platform === "klook" ? "Klook" : run.platform === "ticketplus" ? "TicketPlus" : "未知"}\n` +
            `本次活動：${run.activityName}\n` +
            (recordedAt
                ? `紀錄起始時間：${new Date(recordedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}\n`
                : "") +
            (run.status !== "running" && run.message ? `執行結果：${run.message}\n` : "") +
            eventLogs(run.events, run.historyTruncated);
    }

    useEffect(() => {
        if (logElement.current && followLog.current) logElement.current.scrollTop = logElement.current.scrollHeight;
    }, [logs]);

    // 步驟裡沒有顯示「參加者已填完」時，保留原本的獨立按鈕。
    const participantsInSteps = Boolean(stepsView?.steps.some(step => step.participantsButton));
    const logSection = (
        <>
            <div className={`mb-3 flex flex-wrap items-center gap-3 ${stepsView ? "justify-end" : "justify-between"}`}>
                {/* 步驟畫面已由收合標題寫明「開發者紀錄」，展開後不再重複標題 */}
                {!stepsView && <h3 className="text-base font-semibold">執行紀錄</h3>}
                <div>
                    <button id="copy" className={secondaryButton} onClick={() => onCopy(logs)}>
                        複製紀錄
                    </button>
                </div>
            </div>
            <pre
                className="min-h-40 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-900 p-4 font-mono text-sm leading-7 text-slate-100"
                id="logs"
                ref={logElement}
                tabIndex={0}
                aria-label="執行紀錄"
                onScroll={e => {
                    const element = e.currentTarget;
                    followLog.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30;
                }}
            >
                {logs}
            </pre>
        </>
    );

    return (
        <div data-tailwind className={`${attached ? stepPanel : `${panel} my-4`} space-y-4`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                    <h2 className="text-xl font-semibold" id="status">
                        {title}
                    </h2>
                    {stepsView && (
                        <span
                            className={`status-badge rounded-full px-3 py-1 text-sm font-semibold ${badgeColors[stepsView.badge.tone]}`}
                        >
                            {stepsView.badge.text}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    {stopControl?.available && (
                        <button
                            type="button"
                            className="rounded-lg border border-red-300 bg-white px-4 py-2 text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-600"
                            onClick={stopControl.onStop}
                        >
                            停止購票
                        </button>
                    )}
                    <button
                        id="closeBrowser"
                        className={secondaryButton}
                        hidden={!canClose}
                        disabled={closing}
                        onClick={onClose}
                    >
                        {closing ? "關閉中…" : "關閉購票瀏覽器"}
                    </button>
                </div>
            </div>
            <p id="instruction">{instruction}</p>
            {stepsView && <RunSteps steps={stepsView.steps} participantsControl={participantsControl} />}
            {participantsControl && !participantsInSteps && (
                <button className={primaryButton} type="button" onClick={participantsControl.onConfirm}>
                    參加者已填完
                </button>
            )}
            {stepsView ? (
                <details className="dev-log rounded-lg border border-slate-200 p-4">
                    <summary className="mb-3 cursor-pointer text-sm text-slate-600">開發者紀錄</summary>
                    {logSection}
                </details>
            ) : (
                logSection
            )}
        </div>
    );
}
