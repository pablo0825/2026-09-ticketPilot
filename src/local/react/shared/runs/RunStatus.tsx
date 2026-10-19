import { useEffect, useRef, useState } from "react";
import type { DisplayedRun } from "./useRunStatus.js";
import { eventLogs, purchaseStatus, stopRequestPresentation } from "./runPresentation.js";
import type { StopRequestStatus } from "./runPresentation.js";
import { ticketPlusStepsView } from "./ticketPlusSteps.js";
import type { TicketPlusStepsView } from "./ticketPlusSteps.js";
import { RunSteps } from "./RunSteps.js";

interface Props {
    displayed: DisplayedRun | null;
    canClose: boolean;
    closing: boolean;
    onClose: () => void;
    onCopy: (text: string) => void;
    stopControl?: { available: boolean; progress?: StopRequestStatus; onStop: () => void };
    participantsControl?: { onConfirm: () => void };
}

export function RunStatus({ displayed, canClose, closing, onClose, onCopy, stopControl, participantsControl }: Props) {
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
    } else if (displayed?.kind === "simulation") {
        const run = displayed.run;
        title =
            run.status === "running" ? "模擬執行中" : run.status === "completed" ? "模擬完成（未購票）" : "模擬中斷";
        instruction = "模擬不連線網站、不建立訂單。";
        logs = "模擬執行紀錄（不購票）\n" + eventLogs(run.events, run.historyTruncated);
    }

    useEffect(() => {
        if (logElement.current && followLog.current) logElement.current.scrollTop = logElement.current.scrollHeight;
    }, [logs]);

    // 步驟裡沒有顯示「參加者已填完」時，保留原本的獨立按鈕。
    const participantsInSteps = Boolean(stepsView?.steps.some(step => step.participantsButton));
    const logSection = (
        <>
            <div className="section-title">
                <h3>{stepsView ? "開發者紀錄" : "執行紀錄"}</h3>
                <div>
                    <button id="copy" className="secondary" onClick={() => onCopy(logs)}>
                        複製紀錄
                    </button>
                </div>
            </div>
            <pre
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
        <div className="card">
            <div className="status-header">
                <div className="status-heading">
                    <h2 id="status">{title}</h2>
                    {stepsView && (
                        <span className={`status-badge ${stepsView.badge.tone}`}>{stepsView.badge.text}</span>
                    )}
                </div>
                <div className="status-actions">
                    {stopControl?.available && (
                        <button type="button" className="secondary danger" onClick={stopControl.onStop}>
                            停止購票
                        </button>
                    )}
                    <button
                        id="closeBrowser"
                        className="secondary"
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
                <button type="button" onClick={participantsControl.onConfirm}>
                    參加者已填完
                </button>
            )}
            {stepsView ? (
                <details className="dev-log">
                    <summary>開發者紀錄（除錯用，平常不需要看）</summary>
                    {logSection}
                </details>
            ) : (
                logSection
            )}
        </div>
    );
}
