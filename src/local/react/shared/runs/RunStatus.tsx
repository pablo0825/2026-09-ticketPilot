import { useEffect, useRef, useState } from "react";
import type { DisplayedRun } from "./useRunStatus.js";
import { eventLogs, purchaseStatus } from "./runPresentation.js";

interface Props {
    displayed: DisplayedRun | null;
    canClose: boolean;
    closing: boolean;
    onClose: () => void;
    onCopy: (text: string) => void;
    loginHandoff?: { available: boolean; message: string; onConfirm: () => void };
}

export function RunStatus({ displayed, canClose, closing, onClose, onCopy, loginHandoff }: Props) {
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
    if (displayed?.kind === "purchase") {
        const run = displayed.run;
        ({ title, instruction } = purchaseStatus(run, closing, now));
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

    return (
        <div className="card">
            <h2 id="status">{title}</h2>
            <p id="instruction">{instruction}</p>
            {loginHandoff?.available && (
                <div>
                    <p>請在購票瀏覽器完成登入，並停在設定的活動頁，再確認繼續。</p>
                    <button type="button" onClick={loginHandoff.onConfirm}>
                        我已登入，開始選票
                    </button>
                </div>
            )}
            {loginHandoff?.message && <p role="status">{loginHandoff.message}</p>}
            <button id="closeBrowser" className="secondary" hidden={!canClose} disabled={closing} onClick={onClose}>
                {closing ? "關閉中…" : "關閉購票瀏覽器"}
            </button>
            <div className="section-title">
                <h3>執行紀錄</h3>
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
        </div>
    );
}
