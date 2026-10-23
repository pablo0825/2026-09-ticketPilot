import { KlookActivitySettings, KlookAdvancedSettings } from "./ActivitySettings.js";
import { Breadcrumbs } from "../../shared/navigation/Breadcrumbs.js";
import { StepNavigation } from "../../shared/navigation/StepNavigation.js";
import { AppHeader } from "../../shared/navigation/AppHeader.js";
import { ActivityListPage } from "../../pages/ActivityListPage.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityRecord, KlookActivityRecord } from "../../../../config/activityStore.js";
import type { ContactDetails } from "../../../../config/contact.config.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";
import { api } from "../../shared/api.js";
import { activityForm, activityInput, contactInput, emptyContact, needsActivitySave } from "./formModel.js";
import type { ActivityForm } from "./formModel.js";
import { ActivityEditorPage } from "../../pages/ActivityEditorPage.js";
import { ContactDetailsPage } from "../../pages/ContactDetailsPage.js";
import { PurchaseConfirmPage } from "../../pages/PurchaseConfirmPage.js";
import { klookSummary } from "../../pages/purchaseSummary.js";
import { RunStatus } from "../../shared/runs/RunStatus.js";
import type { useRunStatus } from "../../shared/runs/useRunStatus.js";
import { startPurchase } from "./startPurchase.js";

type ActivityListEntry = KlookActivityRecord & { executionStatus: ActivityExecutionStatus };

interface ActivityListData {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

interface Props {
    message: string;
    setMessage: (message: string) => void;
    runs: ReturnType<typeof useRunStatus>;
    onExit: () => void;
}

export function KlookWorkspace({ message, setMessage, runs, onExit }: Props) {
    const [step, setStep] = useState(0);
    const [editing, setEditing] = useState(false);
    const [form, setForm] = useState(activityForm);
    const [record, setRecord] = useState<KlookActivityRecord | null>(null);
    const [activityBaseline, setActivityBaseline] = useState("");
    const [contact, setContact] = useState<ContactDetails>(emptyContact);
    const [savedContact, setSavedContact] = useState<ContactDetails | null>(null);
    const [contactReady, setContactReady] = useState(false);
    const [initialized, setInitialized] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [activities, setActivities] = useState<ActivityListEntry[]>([]);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const listRequest = useRef(0);

    const refreshList = useCallback(async () => {
        const request = ++listRequest.current;
        const data = await api<ActivityListData>("/api/activities");
        if (request !== listRequest.current) return;
        setActivities(
            data.activities.filter((activity): activity is ActivityListEntry => activity.settings.platform === "klook"),
        );
        if (data.invalidFiles) setMessage(`${data.invalidFiles} 個設定檔無法載入，未覆寫。`);
    }, [setMessage]);

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
        let active = true;
        void refreshList().catch(error => {
            if (active) setMessage(error.message);
        });
        return () => {
            active = false;
        };
    }, [refreshList, statusSignature, setMessage]);

    const occupied = runs.purchase?.occupied === true;
    const locked = busy || runs.closing || !initialized || !runs.ready;
    const blocked = locked || occupied;
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

    function changeBundleEnabled(enabled: boolean) {
        changeForm(
            enabled
                ? { ...form, bundleEnabled: true }
                : {
                      ...form,
                      bundleEnabled: false,
                      deliveryMethod: "",
                      targets: form.targets.map(target => ({ ...target, bundle: "" })),
                  },
        );
    }

    function loadRecord(next: ActivityRecord | null) {
        const settings = next?.settings;
        if (settings && settings.platform !== "klook") throw new Error("此工作區僅支援 Klook 活動。");
        const nextForm = activityForm(settings);
        setRecord(next && settings ? { ...next, settings } : null);
        setForm(nextForm);
        setActivityBaseline(JSON.stringify(activityInput(nextForm)));
        setConfirmed(false);
        setEditing(true);
        runs.resetDisplay();
        setStep(1);
    }

    function acceptSaved(next: ActivityRecord) {
        if (next.settings.platform !== "klook") throw new Error("此工作區僅支援 Klook 活動。");
        setRecord({ ...next, settings: next.settings });
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

    function leavePlatform() {
        // 送出中不能卸載工作區，避免重建同步操作鎖
        if (busyRef.current || runs.closing) return;
        if (hasUnsavedChanges() && !window.confirm("有尚未儲存的修改，要放棄並返回平台首頁嗎？")) return;
        onExit();
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
    }

    return (
        <>
            <AppHeader disabled={busy || runs.closing} onHome={leavePlatform} />
            <div id="message" role="alert">
                {message}
            </div>
            <Breadcrumbs
                disabled={locked}
                items={[
                    { label: "首頁", onSelect: leavePlatform },
                    {
                        label: "Klook",
                        ...(step !== 0 ? { id: "homeButton", actionLabel: "返回活動首頁", onSelect: goHome } : {}),
                    },
                    ...(editing
                        ? [{ label: record?.settings.eventName ?? "新增活動" }]
                        : step === 4
                          ? [{ label: "執行狀態" }]
                          : []),
                ]}
            />
            <div hidden={!editing}>
                <StepNavigation
                    steps={[
                        { id: 1, label: "活動與順位" },
                        { id: 2, label: "聯絡資料" },
                        { id: 3, label: "確認與開始" },
                        { id: 4, label: "執行狀態" },
                    ]}
                    currentStep={step}
                    disabled={locked}
                    onChange={next => {
                        if (!busyRef.current && !runs.closing) setStep(next);
                    }}
                />
            </div>
            <section id="home" hidden={step !== 0}>
                <ActivityListPage
                    activities={activities.map(item => ({
                        id: item.id,
                        eventName: item.settings.eventName,
                        executionStatus: item.executionStatus,
                    }))}
                    disabled={blocked}
                    mutationsDisabled={false}
                    onNew={() => loadRecord(null)}
                    currentRun={{
                        message: homeStatus,
                        disabled: locked,
                        onView: () => {
                            runs.showCurrent();
                            setStep(4);
                        },
                    }}
                    onLoad={id =>
                        void action(async () => loadRecord(await api<ActivityRecord>("/api/activities/" + id)))
                    }
                    onRemove={id => {
                        const item = activities.find(item => item.id === id);
                        if (!item) return;
                        if (
                            window.confirm(`刪除「${item.settings.eventName}」的活動設定？聯絡資料及執行紀錄會保留。`)
                        ) {
                            void action(async () => {
                                await api("/api/activities/" + item.id, "DELETE");
                                await refreshList();
                            });
                        }
                    }}
                />
            </section>
            <section id="step1" hidden={step !== 1}>
                <ActivityEditorPage
                    platform="klook"
                    attached
                    form={form}
                    title={record ? "編輯活動" : "新增活動"}
                    eventName={form.eventName}
                    eventUrl={form.eventUrl}
                    eventUrlPlaceholder="https://www.klook.com/zh-TW/event-detail/…/"
                    onCommonChange={patch => changeForm({ ...form, ...patch })}
                    platformSettings={
                        <KlookActivitySettings
                            form={form}
                            disabled={locked}
                            onQueueChange={queueEnabled => changeForm({ ...form, queueEnabled })}
                            onBundleChange={changeBundleEnabled}
                            onDeliveryChange={deliveryMethod => changeForm({ ...form, deliveryMethod })}
                        />
                    }
                    advancedSettings={
                        <KlookAdvancedSettings
                            exclude={form.exclude}
                            disabled={locked}
                            onChange={exclude => changeForm({ ...form, exclude })}
                        />
                    }
                    disabled={locked}
                    onChange={changeForm}
                    onSave={() => void action(saveActivity)}
                />
            </section>
            <section id="step2" hidden={step !== 2}>
                <ContactDetailsPage
                    attached
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
                <PurchaseConfirmPage
                    platform="klook"
                    attached
                    summary={klookSummary(record?.settings)}
                    execution={{ mode: form.mode, saleAt: form.saleAt, advance: form.advance }}
                    onExecutionChange={next => changeForm({ ...form, ...next })}
                    disabled={locked}
                    executionDisabled={locked}
                    startDisabled={blocked || !editing || legacy || !contactReady}
                    reason={
                        needsSave
                            ? "請先儲存活動設定，再確認並開始購票。"
                            : legacy
                              ? "請先處理套票設定中的舊取票方式。"
                              : !contactReady
                                ? "請先儲存聯絡資料。"
                                : ""
                    }
                    confirmed={confirmed}
                    onConfirm={setConfirmed}
                    confirmation="我已確認活動、順位與張數，並了解程式會提交聯絡資料，停在付款前。"
                    onStart={() => void action(begin)}
                />
            </section>
            <section id="step4" hidden={step !== 4}>
                <RunStatus
                    attached={editing}
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
        </>
    );
}
