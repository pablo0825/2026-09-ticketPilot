import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityRecord } from "../../config/activityStore.js";
import type { ContactDetails } from "../../config/contact.config.js";
import type { ActivityExecutionStatus } from "../purchaseRuns.js";
import { api } from "./api.js";
import { activityForm, activityInput, contactInput, emptyContact, needsActivitySave } from "./formModel.js";
import type { ActivityForm } from "./formModel.js";
import { ActivityEditor } from "./ActivityEditor.js";
import { ContactForm } from "./ContactForm.js";
import { PurchaseSummary } from "./PurchaseSummary.js";
import { RunStatus } from "./RunStatus.js";
import { useRunStatus } from "./useRunStatus.js";
import { startPurchase } from "./startPurchase.js";

interface ActivityList {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

export function App() {
    const [message, setMessage] = useState("");
    const [step, setStep] = useState(0);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState(activityForm);
    const [record, setRecord] = useState<ActivityRecord | null>(null);
    const [activityBaseline, setActivityBaseline] = useState("");
    const [contact, setContact] = useState<ContactDetails>(emptyContact);
    const [savedContact, setSavedContact] = useState<ContactDetails | null>(null);
    const [contactReady, setContactReady] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [activities, setActivities] = useState<ActivityList["activities"]>([]);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const listRequest = useRef(0);
    const runs = useRunStatus(setMessage);

    const refreshList = useCallback(async () => {
        const request = ++listRequest.current;
        const data = await api<ActivityList>("/api/activities");
        if (request !== listRequest.current) return;
        setActivities(data.activities);
        if (data.invalidFiles) setMessage(`${data.invalidFiles} 個設定檔無法載入，未覆寫。`);
    }, []);

    useEffect(() => {
        // 初始資料完成前鎖定編輯，避免較晚回應覆蓋使用者輸入
        let active = true;
        void Promise.all([refreshList(), api<{ contact: ContactDetails | null }>("/api/contact")]).then(
            ([, data]) => {
                if (!active) return;
                setContact(data.contact ?? emptyContact);
                setSavedContact(data.contact);
                setContactReady(Boolean(data.contact));
                setInitialized(true);
            },
            error => active && setMessage(error.message),
        );
        return () => {
            active = false;
            listRequest.current++;
        };
    }, [refreshList]);

    const lastState = runs.purchase?.events.filter(item => item.event.type === "state").at(-1)?.event;
    const statusSignature = JSON.stringify([runs.purchase?.id, runs.purchase?.status, lastState]);
    useEffect(() => {
        void refreshList().catch(error => setMessage(error.message));
    }, [refreshList, statusSignature]);

    const occupied = runs.purchase?.occupied === true;
    const simulationRunning = runs.simulation?.status === "running";
    const locked = busy || !initialized || !runs.ready;
    const blocked = locked || occupied || simulationRunning;
    const legacy = !form.bundleEnabled && Boolean(form.deliveryMethod.trim());
    const needsSave = needsActivitySave(form, record?.settings ?? null);

    async function action(work: () => Promise<unknown>) {
        // 同步鎖避免同一輪事件重複送出，再由 React 更新按鈕
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setMessage("");
        try {
            await work();
        } catch (error) {
            setMessage((error as Error).message);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    function changeForm(next: ActivityForm) {
        setForm(next);
        setConfirmed(false);
    }

    function loadRecord(next: ActivityRecord | null) {
        const nextForm = activityForm(next?.settings);
        setRecord(next);
        setForm(nextForm);
        setActivityBaseline(JSON.stringify(activityInput(nextForm)));
        setConfirmed(false);
        setEditing(true);
        runs.resetDisplay();
        setStep(1);
    }

    function acceptSaved(next: ActivityRecord) {
        setRecord(next);
        setActivityBaseline(JSON.stringify(next.settings));
    }

    function hasUnsavedChanges() {
        if (!editing) return false;
        try {
            return (
                JSON.stringify(activityInput(form)) !== activityBaseline ||
                JSON.stringify(contactInput(contact)) !== JSON.stringify(contactInput(savedContact ?? emptyContact))
            );
        } catch {
            return true;
        }
    }

    function goHome() {
        if (hasUnsavedChanges() && !window.confirm("有尚未儲存的修改，要放棄並返回活動首頁嗎？")) return;
        setEditing(false);
        setRecord(null);
        setConfirmed(false);
        setContact(savedContact ?? emptyContact);
        setContactReady(Boolean(savedContact));
        setStep(0);
        void action(refreshList);
    }

    async function saveActivity() {
        // 第一階段保存活動內容，保留先前已儲存的開賣時間
        if (legacy) throw new Error("請先處理套票設定中的舊取票方式，再儲存或開始。");
        const settings = activityInput(form, false);
        if (record?.settings.saleSchedule) settings.saleSchedule = structuredClone(record.settings.saleSchedule);
        const next = await api<ActivityRecord>(
            "/api/activities" + (record ? "/" + record.id : ""),
            record ? "PUT" : "POST",
            settings,
        );

        // 後端驗證成功才更新保存基準，草稿本身保持原樣
        acceptSaved(next);
        await refreshList();
        setStep(2);
    }

    async function saveContact() {
        const next = contactInput(contact);
        await api("/api/contact", "PUT", next);
        setSavedContact(next);
        setContactReady(true);
        setConfirmed(false);
        setStep(3);
    }

    async function begin() {
        // 確認完整設定和使用者確認，購票不由 effect 或重連觸發
        if (blocked || needsSave || !contactReady || !record) throw new Error("請先儲存並驗證完整設定。");
        if (legacy) throw new Error("請先處理套票設定中的舊取票方式，再儲存或開始。");
        if (!confirmed) throw new Error("請先確認購票摘要。");

        // 同步截取已確認內容，等待期間不再讀取會變動的表單
        const activity = structuredClone(activityInput(form));
        const details = structuredClone(contactInput(contact));
        const previousId = runs.purchase?.id;
        const result = await startPurchase(record, activity, details, acceptSaved);
        runs.showAccepted(result, previousId);
        setStep(4);
    }

    let homeStatus = "";
    if (occupied) {
        homeStatus =
            runs.purchase?.status === "payment-ready"
                ? "自動流程已完成，瀏覽器仍占用中；請完成付款並關閉購票瀏覽器。"
                : runs.purchase?.status === "running"
                  ? "購票流程執行中，不能開始另一輪或刪除活動。"
                  : "購票程序或瀏覽器仍占用中，請查看目前狀態並人工檢查。";
    } else if (simulationRunning) homeStatus = "模擬執行中，不會實際購票。";

    return (
        <main>
            <header>
                <div>
                    <small>本機購票助手</small>
                    <h1>TicketPilot</h1>
                </div>
            </header>
            <button id="homeButton" className="secondary" hidden={step === 0} disabled={locked} onClick={goHome}>
                返回活動首頁
            </button>
            <nav hidden={!editing} aria-label="設定步驟">
                {["① 活動與順位", "② 聯絡資料", "③ 確認與開始", "④ 執行狀態"].map((label, index) => (
                    <button
                        key={label}
                        data-step={index + 1}
                        className={step === index + 1 ? "active" : ""}
                        disabled={locked}
                        onClick={() => setStep(index + 1)}
                    >
                        {label}
                    </button>
                ))}
            </nav>
            <div id="message" role="alert">
                {message}
            </div>
            <section id="home" hidden={step !== 0}>
                <div className="card">
                    <div className="section-title">
                        <h2>活動列表</h2>
                        <button id="new" disabled={blocked} onClick={() => loadRecord(null)}>
                            新增活動
                        </button>
                    </div>
                    <p id="homeRun" hidden={!homeStatus}>
                        {homeStatus}
                    </p>
                    <button
                        id="viewRun"
                        className="secondary"
                        hidden={!homeStatus}
                        disabled={locked}
                        onClick={() => {
                            runs.showCurrent();
                            setStep(4);
                        }}
                    >
                        {!occupied && simulationRunning ? "查看模擬狀態" : "查看目前狀態"}
                    </button>
                    <p id="emptyActivities" hidden={activities.length > 0}>
                        尚未儲存活動，請新增活動。
                    </p>
                    <div className="table-scroll">
                        <table>
                            <thead>
                                <tr>
                                    {["活動名稱", "演出日期", "演出時間", "執行狀態", "操作"].map(title => (
                                        <th key={title}>{title}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody id="activities">
                                {activities.map(item => {
                                    const sessions = new Set(
                                        item.settings.targets.map(target => `${target.date} ${target.time}`),
                                    );
                                    return (
                                        <tr key={item.id}>
                                            <td>{item.settings.eventName}</td>
                                            <td>{sessions.size === 1 ? item.settings.targets[0]!.date : "多個場次"}</td>
                                            <td>{sessions.size === 1 ? item.settings.targets[0]!.time : "多個場次"}</td>
                                            <td
                                                className="activity-status"
                                                title={
                                                    item.executionStatus === "已執行"
                                                        ? "已執行不代表購票或付款成功。"
                                                        : undefined
                                                }
                                            >
                                                {item.executionStatus || "尚無執行紀錄"}
                                            </td>
                                            <td>
                                                <button
                                                    disabled={blocked}
                                                    onClick={() =>
                                                        void action(async () =>
                                                            loadRecord(
                                                                await api<ActivityRecord>("/api/activities/" + item.id),
                                                            ),
                                                        )
                                                    }
                                                >
                                                    使用活動
                                                </button>
                                                <button
                                                    className="secondary"
                                                    disabled={blocked}
                                                    onClick={() => {
                                                        if (
                                                            window.confirm(
                                                                `刪除「${item.settings.eventName}」的活動設定？聯絡資料及執行紀錄會保留。`,
                                                            )
                                                        )
                                                            void action(async () => {
                                                                await api("/api/activities/" + item.id, "DELETE");
                                                                await refreshList();
                                                            });
                                                    }}
                                                >
                                                    刪除
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            </section>
            <section id="step1" hidden={step !== 1}>
                <ActivityEditor
                    form={form}
                    title={record ? `編輯活動：${record.settings.eventName}` : "新增活動"}
                    disabled={locked}
                    onChange={changeForm}
                    onSave={() => void action(saveActivity)}
                />
            </section>
            <section id="step2" hidden={step !== 2}>
                <ContactForm
                    contact={contact}
                    disabled={locked}
                    onChange={next => {
                        setContact(next);
                        setContactReady(false);
                        setConfirmed(false);
                    }}
                    onSave={() => void action(saveContact)}
                />
            </section>
            <section id="step3" hidden={step !== 3}>
                <div id="purchaseSummary" className="card" hidden={!editing}>
                    <h2>本次設定摘要</h2>
                    <div id="summary">
                        {record ? <PurchaseSummary draft={activityInput(form, false)} /> : "請先儲存活動設定。"}
                    </div>
                    <h2>開始時間</h2>
                    <label>
                        執行方式
                        <select
                            id="mode"
                            disabled={locked}
                            value={form.mode}
                            onChange={e => changeForm({ ...form, mode: e.target.value as ActivityForm["mode"] })}
                        >
                            <option value="now">立即開始</option>
                            <option value="scheduled">指定開賣時間</option>
                        </select>
                    </label>
                    <div id="schedule" className="grid" hidden={form.mode === "now"}>
                        <label>
                            開賣時間（台灣 UTC+8）
                            <input
                                id="saleAt"
                                type="datetime-local"
                                step="1"
                                disabled={locked}
                                value={form.saleAt}
                                onChange={e => changeForm({ ...form, saleAt: e.target.value })}
                            />
                        </label>
                        <label>
                            提前刷新
                            <select
                                id="advance"
                                disabled={locked}
                                value={form.advance}
                                onChange={e => changeForm({ ...form, advance: e.target.value })}
                            >
                                <option value="1">1 秒</option>
                                <option value="2">2 秒</option>
                            </select>
                        </label>
                    </div>
                    <p>指定的是開賣時間，不是演出時間。按開始後會先確認登入、準備活動頁，再等待開賣。</p>
                    <label className="check">
                        <input
                            id="confirm"
                            type="checkbox"
                            disabled={locked}
                            checked={confirmed}
                            onChange={e => setConfirmed(e.target.checked)}
                        />
                        我已確認活動、順位與張數，並了解程式會提交聯絡資料，停在付款前。
                    </label>
                    <button
                        id="start"
                        disabled={blocked || !editing || needsSave || legacy || !contactReady || !confirmed}
                        onClick={() => void action(begin)}
                    >
                        開始購票
                    </button>
                </div>
            </section>
            <section id="step4" hidden={step !== 4}>
                <RunStatus
                    displayed={runs.displayed}
                    closing={runs.closing}
                    canClose={
                        runs.displayed?.kind === "purchase" &&
                        runs.displayed.run.id === runs.purchase?.id &&
                        Boolean(runs.purchase?.canCloseBrowser)
                    }
                    onClose={() => void runs.closeBrowser()}
                    onCopy={text => void action(() => navigator.clipboard.writeText(text))}
                />
            </section>
        </main>
    );
}
