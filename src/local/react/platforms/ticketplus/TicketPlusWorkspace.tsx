import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityRecord } from "../../../../config/activityStore.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";
import { api } from "../../shared/api.js";
import { AppHeader } from "../../shared/AppHeader.js";
import type { useRunStatus } from "../../shared/runs/useRunStatus.js";
import { ActivityList } from "./ActivityList.js";
import type { ActivityListEntry } from "./ActivityList.js";
import { ActivityEditor } from "./ActivityEditor.js";
import { activityForm, activityInput, draftFingerprint, ticketPlusRecord } from "./formModel.js";
import type { TicketPlusActivityRecord } from "./formModel.js";
import { ticketPlusSessionSelection } from "../../../../config/ticketPlusActivity.js";
import { PurchaseSummary } from "./PurchaseSummary.js";
import { findPendingStart, hasPendingStart, startPurchase } from "./startPurchase.js";

interface Props {
    message: string;
    setMessage: (message: string) => void;
    runs: ReturnType<typeof useRunStatus>;
    onExit: () => void;
    onViewRun: () => void;
    onStarted: () => void;
}
interface ActivityListData {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

export function TicketPlusWorkspace({ message, setMessage, runs, onExit, onViewRun, onStarted }: Props) {
    const [activities, setActivities] = useState<ActivityListEntry[]>([]);
    const [record, setRecord] = useState<TicketPlusActivityRecord | null>(null);
    const [form, setForm] = useState(activityForm);
    const [baseline, setBaseline] = useState(() => draftFingerprint(form));
    const [editing, setEditing] = useState(false);
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
    const blocked = locked || !initialized || !runs.ready || occupied;
    const dirty = editing && draftFingerprint(form) !== baseline;
    let startReason = !record ? "請先儲存活動設定。" : dirty ? "有尚未儲存的修改，請先儲存再開始。" : "";
    if (record && !startReason) {
        try {
            ticketPlusSessionSelection(record.settings);
        } catch (error) {
            startReason = (error as Error).message;
        }
    }
    const hasRun = Boolean(
        runs.purchase?.occupied ||
        runs.purchase?.status === "unknown" ||
        runs.purchase?.status === "interrupted" ||
        runs.simulation?.status === "running",
    );

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
        setRecord(next);
        setForm(nextForm);
        setBaseline(draftFingerprint(nextForm));
        setEditing(true);
        setMessage("");
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

        // 保存成功先接受 ID 與新版本；後續列表失敗不能造成第二次新增。
        openRecord(next);
        setActivities(previous => [
            { ...next, executionStatus: "待重新載入" },
            ...previous.filter(item => item.id !== next.id),
        ]);
        setEditing(false);
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

    async function start() {
        if (blocked || startReason || !record) return;
        const previousId = runs.purchase?.id;
        const result = await startPurchase(record);
        if (!active.current) return;
        runs.showAccepted(result, previousId);
        onStarted();
    }

    async function inspectPending() {
        const previousId = runs.purchase?.id;
        const result = await findPendingStart();
        if (!active.current) return;
        runs.showAccepted(result, previousId);
        onStarted();
    }

    return (
        <>
            <AppHeader disabled={locked} onHome={() => leave("platforms")} />
            <div id="message" role="alert">
                {message}
            </div>
            {occupied && <p role="status">目前有購票瀏覽器占用或模擬正在執行，暫時無法變更活動設定。</p>}
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
                    <button id="homeButton" className="secondary" disabled={locked} onClick={() => leave("list")}>
                        返回活動首頁
                    </button>
                    <ActivityEditor
                        form={form}
                        saved={record?.settings}
                        disabled={blocked || pendingStart}
                        onChange={setForm}
                        onSave={() => void action(save)}
                    />
                    <PurchaseSummary
                        settings={record?.settings}
                        reason={startReason}
                        disabled={blocked}
                        onStart={() => void action(start)}
                    />
                </>
            ) : (
                <>
                    {hasRun && (
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
                    />
                </>
            )}
        </>
    );
}
