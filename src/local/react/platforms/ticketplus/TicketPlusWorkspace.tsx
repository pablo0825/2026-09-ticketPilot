import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityRecord } from "../../../../config/activityStore.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";
import { api } from "../../shared/api.js";
import { AppHeader } from "../../shared/AppHeader.js";
import type { useRunStatus } from "../../shared/runs/useRunStatus.js";
import { RunStatus } from "../../shared/runs/RunStatus.js";
import { ActivityList } from "./ActivityList.js";
import { Breadcrumb } from "./Breadcrumb.js";
import { ticketPlusRunBadge } from "../../shared/runs/ticketPlusSteps.js";
import type { ActivityListEntry } from "./ActivityList.js";
import { ActivityEditor } from "./ActivityEditor.js";
import {
    activityForm,
    activityInput,
    draftFingerprint,
    ticketPlusRecord,
    executionForm,
    executionFingerprint,
    executionInput,
    executionErrors,
} from "./formModel.js";
import type { TicketPlusActivityRecord, ExecutionForm, ExecutionErrors } from "./formModel.js";
import { ticketPlusSessionSelection } from "../../../../config/ticketPlusActivity.js";
import { PurchaseSummary } from "./PurchaseSummary.js";
import { ExecutionEditor } from "./ExecutionEditor.js";
import { findPendingStart, hasPendingStart, startPurchase } from "./startPurchase.js";

interface Props {
    message: string;
    setMessage: (message: string) => void;
    runs: ReturnType<typeof useRunStatus>;
    onExit: () => void;
    onViewRun: () => void;
    onPendingResolved: () => void;
}
interface ActivityListData {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

type Step = "activity" | "confirm" | "status";
const steps: { id: Step; label: string }[] = [
    { id: "activity", label: "活動與順位" },
    { id: "confirm", label: "確認與開始" },
    { id: "status", label: "執行狀態" },
];

export function TicketPlusWorkspace({ message, setMessage, runs, onExit, onViewRun, onPendingResolved }: Props) {
    const [activities, setActivities] = useState<ActivityListEntry[]>([]);
    const [record, setRecord] = useState<TicketPlusActivityRecord | null>(null);
    const [form, setForm] = useState(activityForm);
    const [baseline, setBaseline] = useState(() => draftFingerprint(form));
    const [execution, setExecution] = useState(executionForm);
    const [executionBaseline, setExecutionBaseline] = useState(() => executionFingerprint(execution));
    const [fieldErrors, setFieldErrors] = useState<ExecutionErrors>({});
    const [confirmed, setConfirmed] = useState(false);
    const [editing, setEditing] = useState(false);
    const [step, setStep] = useState<Step>("activity");
    const [startedRunId, setStartedRunId] = useState<string | null>(null);
    const [initialized, setInitialized] = useState(false);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const active = useRef(true);
    const listRequest = useRef(0);
    const [pendingStart, setPendingStart] = useState(hasPendingStart);

    const refreshList = useCallback(async () => {
        const request = ++listRequest.current;
        const data = await api<ActivityListData>("/api/activities");
        if (!active.current || request !== listRequest.current) return;
        const items = data.activities
            .filter(item => item.settings.platform === "ticketplus")
            .map(item => ({
                ...ticketPlusRecord(item),
                executionStatus: item.executionStatus,
            }));
        setActivities(items);
        setInitialized(true);
        if (data.invalidFiles) setMessage(`${data.invalidFiles} 個設定檔無法載入，未覆寫。`);
        return data.invalidFiles;
    }, [setMessage]);

    // 活動設定不依賴聯絡資料；全域狀態訂閱仍由 App 唯一持有。
    const statusKey = JSON.stringify([runs.purchase?.id, runs.purchase?.status, runs.purchase?.occupied]);
    useEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            listRequest.current++;
        };
    }, []);
    useEffect(() => {
        let current = true;
        void refreshList().catch(error => {
            if (active.current && current) {
                setMessage(`${(error as Error).message} 請返回平台首頁後重新進入。`);
            }
        });
        return () => {
            current = false;
            listRequest.current++;
        };
    }, [refreshList, statusKey, setMessage]);

    const occupied = runs.purchase?.occupied === true || runs.simulation?.status === "running";
    const locked = busy || runs.closing;
    const activityTitle = record?.settings.eventName ?? "新增活動";
    const blocked = locked || !initialized || !runs.ready || occupied;
    const activityDirty = editing && draftFingerprint(form) !== baseline;
    const executionDirty = editing && executionFingerprint(execution) !== executionBaseline;
    const dirty = activityDirty || executionDirty;
    let startReason = !record
        ? "請先儲存活動設定。"
        : activityDirty
          ? "活動與順位有尚未儲存的修改，請先儲存再開始。"
          : "";
    if (record && !startReason) {
        try {
            ticketPlusSessionSelection(record.settings);
        } catch (error) {
            startReason = (error as Error).message;
        }
    }
    // 占用中的 TicketPlus 執行若對應到列表裡的活動，就在那一列顯示狀態，不另外放上方按鈕。
    const runningActivityId =
        runs.purchase?.occupied && runs.purchase.platform === "ticketplus" ? runs.purchase.activityId : undefined;
    const runningListed = activities.some(item => item.id === runningActivityId);
    const hasRun = Boolean(
        runs.purchase?.occupied ||
        runs.purchase?.status === "unknown" ||
        runs.purchase?.status === "interrupted" ||
        runs.simulation?.status === "running",
    );
    // 只呈現這個工作區啟動的流程，不以活動名稱推論歷史紀錄的歸屬。
    const displayedRun =
        runs.displayed?.kind === "purchase" &&
        runs.displayed.run.platform === "ticketplus" &&
        runs.displayed.run.id === startedRunId
            ? runs.displayed
            : null;

    async function action(work: () => Promise<unknown>) {
        // 同步鎖涵蓋保存與導覽，避免 React 尚未更新按鈕時重複送出。
        if (busyRef.current || runs.closing) return;
        busyRef.current = true;
        setBusy(true);
        setMessage("");
        try {
            await work();
        } catch (error) {
            if (active.current) setMessage((error as Error).message);
        } finally {
            busyRef.current = false;
            if (active.current) {
                setBusy(false);
                setPendingStart(hasPendingStart());
            }
        }
    }

    function leave(destination: "list" | "platforms") {
        if (busyRef.current || runs.closing) return;
        if (dirty && !window.confirm("有尚未儲存的修改，要放棄並離開嗎？")) return;
        setMessage("");
        if (destination === "platforms") onExit();
        else {
            setEditing(false);
            void action(refreshList);
        }
    }

    function openRecord(next: TicketPlusActivityRecord | null) {
        const nextForm = activityForm(next?.settings);
        setFieldErrors({});
        setRecord(next);
        setForm(nextForm);
        setBaseline(draftFingerprint(nextForm));
        const nextExecution = executionForm(next?.settings);
        setExecution(nextExecution);
        setExecutionBaseline(executionFingerprint(nextExecution));
        setConfirmed(false);
        setEditing(true);
        setStep("activity");
        setStartedRunId(null);
        setMessage("");
    }

    function changeStep(next: Step) {
        if (busyRef.current || runs.closing) return;
        setStep(next);
    }

    async function save() {
        // 只轉換已確認的 TicketPlus 欄位，版本衝突保留草稿不自動重送。
        if (blocked || hasPendingStart()) return;
        const settings = activityInput(form, record?.settings);
        const response = await api<unknown>(
            "/api/activities" + (record ? "/" + record.id : ""),
            record ? "PUT" : "POST",
            settings,
            record?.updatedAt,
        );
        const next = ticketPlusRecord(response, record?.id);
        if (!active.current) return;
        await acceptSaved(next, executionDirty ? execution : undefined);
    }

    function acceptExecutionSaved(next: TicketPlusActivityRecord) {
        // 立即接受新版本；啟動不依賴活動列表刷新成功。
        if (!active.current) return;
        setFieldErrors({});
        setRecord(next);
        const nextExecution = executionForm(next.settings);
        setExecution(nextExecution);
        setExecutionBaseline(executionFingerprint(nextExecution));
        setActivities(previous => previous.map(item => (item.id === next.id ? { ...item, ...next } : item)));
    }

    async function acceptSaved(next: TicketPlusActivityRecord, retainedExecution?: ExecutionForm) {
        // 保存成功先接受 ID 與新版本；後續列表失敗不能造成第二次新增。
        openRecord(next);
        if (retainedExecution) setExecution(retainedExecution);
        setActivities(previous => [
            { ...next, executionStatus: "待重新載入" },
            ...previous.filter(item => item.id !== next.id),
        ]);
        setStep("confirm");
        try {
            const invalidFiles = await refreshList();
            if (active.current && invalidFiles !== undefined) {
                const warning = invalidFiles ? `${invalidFiles} 個設定檔無法載入，未覆寫。` : "";
                setMessage("活動已儲存，尚未啟動購票。" + warning);
            }
        } catch {
            if (active.current) setMessage("活動已儲存，但列表重新載入失敗；請返回平台首頁後重新進入。");
        }
    }

    async function remove(item: ActivityListEntry) {
        if (
            blocked ||
            hasPendingStart() ||
            !window.confirm(`刪除「${item.settings.eventName}」的 TicketPlus 活動設定？執行紀錄會保留。`)
        ) {
            return;
        }
        await api("/api/activities/" + item.id, "DELETE");
        if (!active.current) return;
        setActivities(previous => previous.filter(value => value.id !== item.id));
        try {
            await refreshList();
        } catch {
            if (active.current) setMessage("活動已刪除，但列表重新載入失敗；請返回平台首頁後重新進入。");
        }
    }

    function requestStart() {
        if (blocked || startReason || !record || !confirmed) return;
        const errors = executionErrors(execution);
        setFieldErrors(errors);
        if (Object.keys(errors).length > 0) return;
        void action(start);
    }

    async function start() {
        if (blocked || startReason || !record || !confirmed) return;
        const previousId = runs.purchase?.id;
        const candidate = executionInput(execution, record.settings);
        const result = await startPurchase(record, candidate, acceptExecutionSaved);
        if (!active.current) return;
        runs.showAccepted(result, previousId);
        setStartedRunId(result.id);
        setStep("status");
    }

    async function inspectPending() {
        const previousId = runs.purchase?.id;
        const result = await findPendingStart();
        if (!active.current) return;
        runs.showAccepted(result, previousId);
        // 待確認請求可能屬於其他活動，沿用全域狀態頁供人工核對。
        onPendingResolved();
    }

    return (
        <>
            <AppHeader disabled={locked} onHome={() => leave("platforms")} />
            <div id="message" role="alert">
                {message}
            </div>
            {pendingStart && (
                <div role="status">
                    <p>有待確認的 TicketPlus 啟動請求。先核對原流程，暫不變更或刪除設定；不會自動重跑。</p>
                    <button type="button" disabled={locked || !runs.ready} onClick={() => void action(inspectPending)}>
                        查看待確認的啟動結果
                    </button>
                </div>
            )}
            {editing ? (
                <>
                    {/* 只顯示已儲存的名稱，輸入中的名稱要按儲存後才更新。 */}
                    <Breadcrumb
                        activityTitle={activityTitle}
                        disabled={locked}
                        showLockChip={occupied}
                        onPlatforms={() => leave("platforms")}
                        onList={() => leave("list")}
                    />
                    <nav className="step-tabs" aria-label="設定步驟">
                        {steps.map(item => (
                            <button
                                type="button"
                                key={item.id}
                                aria-current={step === item.id ? "step" : undefined}
                                disabled={locked}
                                onClick={() => changeStep(item.id)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </nav>
                    {step === "activity" && (
                        <ActivityEditor
                            form={form}
                            saved={record?.settings}
                            disabled={blocked || pendingStart}
                            onChange={next => {
                                setForm(next);
                                setConfirmed(false);
                            }}
                            onSave={() => void action(save)}
                        />
                    )}
                    {step === "confirm" && (
                        <PurchaseSummary
                            settings={record?.settings}
                            reason={startReason}
                            hideReason={Boolean(record) && activityDirty}
                            disabled={blocked}
                            onStart={requestStart}
                            confirmed={confirmed}
                            onConfirm={setConfirmed}
                        >
                            <ExecutionEditor
                                form={execution}
                                errors={fieldErrors}
                                disabled={blocked || pendingStart}
                                onChange={next => {
                                    setExecution(next);
                                    setFieldErrors({});
                                    setConfirmed(false);
                                }}
                            />
                        </PurchaseSummary>
                    )}
                    {step === "status" &&
                        (displayedRun ? (
                            <RunStatus
                                displayed={displayedRun}
                                stopControl={runs.stopControl}
                                participantsControl={runs.participantsControl}
                                closing={runs.closing}
                                canClose={
                                    displayedRun.run.id === runs.purchase?.id && Boolean(runs.purchase?.canCloseBrowser)
                                }
                                onClose={() => void runs.closeBrowser()}
                                onCopy={text =>
                                    void navigator.clipboard.writeText(text).catch(error => setMessage(error.message))
                                }
                            />
                        ) : (
                            <section className="card">
                                <h2>尚未開始</h2>
                                <p>請在「確認與開始」確認已儲存的設定，再開始購票。</p>
                            </section>
                        ))}
                </>
            ) : (
                <>
                    <Breadcrumb
                        disabled={locked}
                        showLockChip={occupied}
                        onPlatforms={() => leave("platforms")}
                        onList={() => leave("list")}
                    />
                    {hasRun && initialized && !runningListed && (
                        <div className="section-title">
                            <button className="secondary" disabled={locked} onClick={onViewRun}>
                                查看目前狀態
                            </button>
                        </div>
                    )}
                    <ActivityList
                        activities={activities}
                        disabled={blocked}
                        mutationsDisabled={pendingStart}
                        onNew={() => {
                            if (!blocked && !hasPendingStart()) openRecord(null);
                        }}
                        onLoad={id =>
                            void action(async () => {
                                if (blocked) return;
                                const next = ticketPlusRecord(await api<unknown>("/api/activities/" + id), id);
                                if (active.current) openRecord(next);
                            })
                        }
                        onRemove={item => void action(() => remove(item))}
                        running={
                            runs.purchase && runningActivityId && runningListed
                                ? {
                                      id: runningActivityId,
                                      badge: ticketPlusRunBadge(runs.purchase),
                                      viewDisabled: locked,
                                      onView: onViewRun,
                                  }
                                : undefined
                        }
                    />
                </>
            )}
        </>
    );
}
