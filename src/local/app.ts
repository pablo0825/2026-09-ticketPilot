import type { ActivityRecord, ActivitySettings } from "../config/activityStore.js";
import type { ContactDetails } from "../config/contact.config.js";
import type { PurchaseSnapshot, ActivityExecutionStatus } from "./purchaseRuns.js";
import type { SimulationSnapshot } from "./simulationRuns.js";

// token 由 index.html 在載入此腳本前提供。
declare const token: string;

type DisplayMode = "purchase" | "simulation";

interface DisplayedRun {
    kind: DisplayMode;
    id: string;
}

interface PendingRequest {
    requestId: string;
    activityId: string;
    signature: string;
}

interface ApiError extends Error {
    notAccepted?: boolean;
}

interface ActivityList {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

// 表單尚未通過後端驗證；開賣提前秒數先保留原始數值。
interface ScheduleDraft {
    saleAt: string;
    advanceSeconds?: number;
}

type ActivityDraft = Omit<ActivitySettings, "saleSchedule"> & { saleSchedule?: ScheduleDraft };
type TargetFields = Omit<ActivitySettings["targets"][number], "unitPrice"> & { unitPrice: number | string };
type ActivityFields = Omit<ActivityDraft, "fallbackMode" | "targets"> & { targets: TargetFields[] };
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement;

// 對照 index.html 的固定元素，讓每次查詢取得對應的欄位型別。
interface PageElements {
    homeButton: HTMLButtonElement;
    message: HTMLElement;
    home: HTMLElement;
    new: HTMLButtonElement;
    homeRun: HTMLElement;
    viewRun: HTMLButtonElement;
    emptyActivities: HTMLElement;
    activities: HTMLElement;
    step1: HTMLElement;
    editorTitle: HTMLElement;
    eventName: HTMLInputElement;
    eventUrl: HTMLInputElement;
    add: HTMLButtonElement;
    targets: HTMLElement;
    exclude: HTMLInputElement;
    saveActivity: HTMLButtonElement;
    step2: HTMLElement;
    lastName: HTMLInputElement;
    firstName: HTMLInputElement;
    regionLabel: HTMLSelectElement;
    phone: HTMLInputElement;
    email: HTMLInputElement;
    saveContact: HTMLButtonElement;
    step3: HTMLElement;
    purchaseSummary: HTMLElement;
    summary: HTMLElement;
    mode: HTMLSelectElement;
    schedule: HTMLElement;
    saleAt: HTMLInputElement;
    advance: HTMLSelectElement;
    confirm: HTMLInputElement;
    start: HTMLButtonElement;
    step4: HTMLElement;
    status: HTMLElement;
    instruction: HTMLElement;
    closeBrowser: HTMLButtonElement;
    copy: HTMLButtonElement;
    logs: HTMLElement;
}

// 畫面目前的狀態
let activityListRequest = 0;
let activityStatusSignature = "";
const $ = <Id extends keyof PageElements>(id: Id): PageElements[Id] => document.getElementById(id) as PageElements[Id];
let selectedId = "";
let savedActivity: ActivitySettings | null = null;
let contactReady = false;
let displayMode: DisplayMode = "purchase";
let displayedRun: DisplayedRun | null = null;
let savedRevision = "";
let editing = false;
let actionBusy = false;
let activityBaseline = "";
let contactBaseline = "";
let savedContactReady = false;
let latestSimulation: SimulationSnapshot | null = null;
let closingBrowser = false;
let occupied = false;
let simulationRunning = false;
let requesting = false;
let pendingRequest: PendingRequest | null = null;
let currentRun: PurchaseSnapshot | null = null;
let followLog = true;

async function api<T = unknown>(path: string, method = "GET", value?: unknown, revision?: string): Promise<T> {
    // 送出請求，帶上本機 token
    const response = await fetch(path, {
        method,
        headers: {
            "X-Local-Token": token,
            "Content-Type": "application/json",
            ...(revision ? { "X-Activity-Revision": revision } : {}),
        },
        body: value === undefined ? undefined : JSON.stringify(value),
    });

    // 讀取回應；失敗時拋出伺服器的錯誤訊息
    const data: unknown = await response.json();
    if (!response.ok) {
        const failure = data as { error: string; notAccepted?: boolean };
        const error: ApiError = Error(failure.error);
        error.notAccepted = failure.notAccepted === true;
        throw error;
    }

    return data as T;
}

function showStep(step: string | number | undefined): void {
    // 進入確認步驟前，更新目前的摘要
    if (String(step) === "3") {
        summary();
    }

    // 切換可見區塊與返回按鈕
    document.querySelectorAll<HTMLElement>("main > section").forEach(el => {
        el.hidden = el.id !== `step${step}`;
    });
    document.querySelector("nav")!.hidden = !editing;
    $("homeButton").hidden = false;
    $("purchaseSummary").hidden = !editing;

    // 標示目前所在的步驟
    document.querySelectorAll<HTMLButtonElement>("nav button").forEach(el => {
        el.classList.toggle("active", el.dataset.step === String(step));
    });
}

document.querySelectorAll<HTMLButtonElement>("nav button").forEach(button => {
    button.onclick = () => showStep(button.dataset.step);
});

function controls() {
    // 更新關閉購票瀏覽器的按鈕
    $("closeBrowser").hidden =
        displayedRun?.kind !== "purchase" || displayedRun.id !== currentRun?.id || !currentRun?.canCloseBrowser;
    $("closeBrowser").disabled = closingBrowser;
    $("closeBrowser").textContent = closingBrowser ? "關閉中…" : "關閉購票瀏覽器";

    // 只有設定已儲存、已確認且沒有其他操作時，才能開始
    $("start").disabled =
        !editing ||
        actionBusy ||
        occupied ||
        simulationRunning ||
        requesting ||
        activityNeedsSave() ||
        !contactReady ||
        !$("confirm").checked;

    // 同步更新首頁按鈕
    updateHomeControls();
}

function updateHomeStatus() {
    // 首頁只顯示需要處理的目前狀態；紀錄仍留在第四步及本機。
    $("homeRun").hidden = true;
    $("homeRun").textContent = "";
    $("viewRun").hidden = true;

    if (occupied) {
        $("homeRun").hidden = false;
        $("viewRun").hidden = false;
        $("viewRun").textContent = "查看目前狀態";
        if (currentRun?.status === "payment-ready") {
            $("homeRun").textContent = "自動流程已完成，瀏覽器仍占用中；請完成付款並關閉購票瀏覽器。";
        } else if (currentRun?.status === "running") {
            $("homeRun").textContent = "購票流程執行中，不能開始另一輪或刪除活動。";
        } else {
            $("homeRun").textContent = "購票程序或瀏覽器仍占用中，請查看目前狀態並人工檢查。";
        }
    } else if (simulationRunning) {
        $("homeRun").hidden = false;
        $("viewRun").hidden = false;
        $("viewRun").textContent = "查看模擬狀態";
        $("homeRun").textContent = "模擬執行中，不會實際購票。";
    }
}

function updateHomeControls() {
    updateHomeStatus();

    const blocked = actionBusy || requesting || occupied || simulationRunning;
    $("new").disabled = blocked;
    document.querySelectorAll<HTMLButtonElement>("#activities button").forEach(button => {
        button.disabled = blocked;
    });

    $("homeButton").disabled = actionBusy || requesting;
    $("viewRun").disabled = actionBusy || requesting;
}

function hasUnsavedChanges() {
    if (!editing) {
        return false;
    }
    try {
        return (
            JSON.stringify(activityInput()) !== activityBaseline || JSON.stringify(contactInput()) !== contactBaseline
        );
    } catch {
        return true;
    }
}

function allowLeave() {
    return !hasUnsavedChanges() || window.confirm("有尚未儲存的修改，要放棄並返回活動首頁嗎？");
}

async function goHome() {
    // 確認可以離開，結束編輯
    if (!allowLeave()) {
        return;
    }
    editing = false;
    if (currentRun) {
        render(currentRun);
    }

    selectedId = "";
    savedActivity = null;
    $("confirm").checked = false;

    // 還原已儲存的聯絡資料
    if (contactBaseline) {
        for (const [id, value] of Object.entries(JSON.parse(contactBaseline)) as [keyof ContactDetails, string][]) {
            $(id).value = value;
        }
        contactReady = savedContactReady;
    }

    // 切回活動首頁，重新載入列表
    document.querySelectorAll<HTMLElement>("main > section").forEach(el => {
        el.hidden = el.id !== "home";
    });
    document.querySelector("nav")!.hidden = true;
    $("homeButton").hidden = true;
    await action(list);
}

$("homeButton").onclick = goHome;

$("viewRun").onclick = () => {
    if (latestSimulation && !occupied && (simulationRunning || displayMode === "simulation")) {
        displayMode = "simulation";
        displayedRun = { kind: "simulation", id: latestSimulation.id };
        renderSimulation(latestSimulation);
    } else {
        displayMode = "purchase";
        displayedRun = currentRun ? { kind: "purchase", id: currentRun.id } : null;
        render(currentRun);
    }

    showStep(4);
};

function changed() {
    $("confirm").checked = false;
    controls();
}

$("confirm").onchange = controls;

function row(data: TargetFields = { date: "", time: "", area: "", unitPrice: "", quantity: 1, adjacent: false }) {
    // 建立一列順位欄位，並填入資料
    const container = document.createElement("div");
    container.className = "target-row";
    container.innerHTML =
        '<div class="target-fields"><label>演出日期<input name="date" type="date" required></label><label>演出時間<input name="time" type="time" required></label><label>票區／票種<input name="area" required></label><label>單張價格（NT$）<input name="unitPrice" type="number" min="1" step="1" required></label><label>張數<input name="quantity" type="number" min="1" step="1" required></label></div><div class="target-tools"><strong class="position"></strong><label class="check"><input name="adjacent" type="checkbox">要求連位</label><button type="button" class="secondary up">上移</button><button type="button" class="secondary down">下移</button><button type="button" class="secondary remove">移除</button></div>';

    for (const [key, value] of Object.entries(data)) {
        const input = container.querySelector<HTMLInputElement>(`[name="${key}"]`);
        if (input) {
            if (key === "adjacent") {
                input.checked = value as boolean;
            } else {
                input.value = String(value);
            }
        }
    }

    // 只買一張時，不能要求連位
    const quantity = container.querySelector<HTMLInputElement>('[name="quantity"]')!;
    const adjacent = container.querySelector<HTMLInputElement>('[name="adjacent"]')!;
    const sync = () => {
        adjacent.disabled = Number(quantity.value) <= 1;
        if (adjacent.disabled) {
            adjacent.checked = false;
        }
    };
    sync();
    quantity.addEventListener("input", sync);

    // 上移、下移、移除按鈕；只剩一列時改成清空
    container.querySelector<HTMLButtonElement>(".up")!.onclick = () => {
        if (container.previousElementSibling) {
            container.before(container.previousElementSibling);
        }
        renumber();
        changed();
    };

    container.querySelector<HTMLButtonElement>(".down")!.onclick = () => {
        if (container.nextElementSibling) {
            container.after(container.nextElementSibling);
        }
        renumber();
        changed();
    };

    container.querySelector<HTMLButtonElement>(".remove")!.onclick = () => {
        if ($("targets").children.length > 1) {
            container.remove();
        } else {
            for (const name of ["date", "time", "area", "unitPrice"]) {
                container.querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = "";
            }
            quantity.value = "1";
            adjacent.checked = false;
            sync();
        }

        renumber();
        changed();
    };

    // 加到畫面並重新編號
    $("targets").append(container);
    renumber();
}

function renumber() {
    const rows = [...$("targets").children];
    rows.forEach((el, i) => {
        el.querySelector<HTMLElement>(".position")!.textContent = `順位 ${i + 1}`;
        el.querySelector<HTMLElement>(".remove")!.textContent = rows.length === 1 ? "清空" : "移除";
    });
}

$("add").onclick = () => {
    row();
    changed();
};

function loadForm(settings: ActivityFields): void {
    // 填入活動基本欄位
    $("eventName").value = settings.eventName;
    $("eventUrl").value = settings.eventUrl;
    $("exclude").value = settings.excludeKeywords.join(",");

    // 依儲存順序重建購票順位
    $("targets").replaceChildren();
    settings.targets.forEach(row);

    // 還原開賣設定，並要求重新確認
    $("mode").value = settings.saleSchedule ? "scheduled" : "now";
    $("saleAt").value = settings.saleSchedule?.saleAt.slice(0, 19) ?? "";
    $("advance").value = String(settings.saleSchedule?.advanceSeconds ?? 1);
    $("schedule").hidden = $("mode").value === "now";

    $("confirm").checked = false;
}

function activityInput(includeSchedule = true): ActivityDraft {
    // 讀取每一列順位
    const targets = [...$("targets").children].map(
        el =>
            Object.fromEntries(
                [...el.querySelectorAll<HTMLInputElement>("[name]")].map(input => {
                    let value: boolean | number | string;
                    if (input.type === "checkbox") {
                        value = input.checked;
                    } else if (input.type === "number") {
                        value = Number(input.value);
                    } else {
                        value = input.value;
                    }
                    return [input.name, value];
                }),
            ) as ActivitySettings["targets"][number],
    );

    // 組成活動設定；需要時加上開賣時間
    const settings: ActivityDraft = {
        eventUrl: $("eventUrl").value.trim(),
        eventName: $("eventName").value.trim(),
        fallbackMode: "STRICT",
        excludeKeywords: $("exclude")
            .value.split(/[,，]/)
            .map(v => v.trim())
            .filter(Boolean),
        targets,
    };

    if (includeSchedule) {
        const schedule = scheduleInput();
        if (schedule) {
            settings.saleSchedule = schedule;
        }
    }

    return settings;
}

function scheduleInput(): ScheduleDraft | undefined {
    if ($("mode").value !== "scheduled") {
        return undefined;
    }
    const raw = $("saleAt").value;
    if (!raw) {
        throw Error("請填寫開賣時間。");
    }
    return {
        saleAt: (raw.length === 16 ? raw + ":00" : raw) + "+08:00",
        advanceSeconds: Number($("advance").value),
    };
}

function activityNeedsSave() {
    if (!savedActivity) {
        return true;
    }
    const { saleSchedule, ...savedFields } = savedActivity;
    return JSON.stringify(activityInput(false)) !== JSON.stringify(savedFields);
}

function resetRunView() {
    displayedRun = null;
    $("status").textContent = "尚未執行";
    $("instruction").textContent = "請在第三步確認設定並開始。";
    $("logs").textContent = "尚無紀錄。";
}

function contactInput(): ContactDetails {
    return Object.fromEntries(
        (["firstName", "lastName", "regionLabel", "phone", "email"] as const).map(id => [id, $(id).value.trim()]),
    ) as ContactDetails;
}

async function list() {
    // 讀取活動列表；只採用最新一次請求的結果
    const request = ++activityListRequest;
    const data = await api<ActivityList>("/api/activities");
    if (request !== activityListRequest) {
        return;
    }

    // 每個活動一列：名稱、日期、時間、執行狀態與操作按鈕
    $("activities").replaceChildren();
    $("emptyActivities").hidden = data.activities.length > 0;

    for (const item of data.activities) {
        const tr = document.createElement("tr");
        const sessions = [...new Set(item.settings.targets.map(target => `${target.date} ${target.time}`))];
        const first = item.settings.targets[0]!;

        for (const text of [
            item.settings.eventName,
            sessions.length === 1 ? first.date : "多個場次",
            sessions.length === 1 ? first.time : "多個場次",
        ]) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }

        const status = document.createElement("td");
        status.className = "activity-status";
        status.textContent = item.executionStatus || "尚無執行紀錄";
        if (item.executionStatus === "已執行") {
            status.title = "已執行不代表購票或付款成功。";
        }
        tr.append(status);

        const actions = document.createElement("td");

        const use = document.createElement("button");
        use.textContent = "使用活動";
        use.onclick = () =>
            action(async () => {
                const record = await api<ActivityRecord>("/api/activities/" + item.id);
                selectedId = record.id;
                savedActivity = record.settings;
                savedRevision = record.updatedAt;

                resetRunView();
                editing = true;
                loadForm(savedActivity);
                activityBaseline = JSON.stringify(activityInput());

                $("editorTitle").textContent = `編輯活動：${savedActivity.eventName}`;
                summary();
                showStep(1);
            });

        const remove = document.createElement("button");
        remove.className = "secondary";
        remove.textContent = "刪除";
        remove.onclick = () => {
            if (!window.confirm(`刪除「${item.settings.eventName}」的活動設定？聯絡資料及執行紀錄會保留。`)) {
                return;
            }
            action(async () => {
                await api("/api/activities/" + item.id, "DELETE");
                await list();
            });
        };

        actions.append(use, remove);
        tr.append(actions);
        $("activities").append(tr);
    }

    // 更新按鈕；有無法載入的設定檔就提示
    updateHomeControls();
    if (data.invalidFiles) {
        $("message").textContent = `${data.invalidFiles} 個設定檔無法載入，未覆寫。`;
    }
}

function summary() {
    // 用目前表單內容產生摘要
    if (!savedActivity) {
        return;
    }
    const draft = activityInput(false);
    const root = $("summary");
    root.replaceChildren();

    const field = (label: string, value: string) => {
        const line = document.createElement("div");
        line.className = "summary-field";

        const title = document.createElement("span");
        title.className = "summary-label";
        title.textContent = label + "｜";

        const content = document.createElement("span");
        content.textContent = value || "未填寫";

        line.append(title, content);
        root.append(line);
        return content;
    };

    field("活動名稱", draft.eventName);
    const address = field("活動網址", draft.eventUrl);

    // 摘要可能讀到尚未儲存的草稿，不能假設網址已通過後端驗證。
    try {
        const url = new URL(draft.eventUrl);
        if (
            url.protocol === "https:" &&
            url.hostname === "www.klook.com" &&
            /^\/zh-TW\/event-detail\/[^/]+\/$/.test(url.pathname) &&
            !url.username &&
            !url.password
        ) {
            const link = document.createElement("a");
            link.href = draft.eventUrl;
            link.textContent = draft.eventUrl;
            link.title = draft.eventUrl;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            address.replaceChildren(link);
        }
    } catch {
        /* 不完整網址只顯示文字。 */
    }

    // 購票順位表格
    const heading = document.createElement("h3");
    heading.textContent = "購票順位";

    const scroll = document.createElement("div");
    scroll.className = "summary-table-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "購票順位");

    const table = document.createElement("table");
    const header = table.createTHead().insertRow();
    for (const title of ["順位", "演出日期", "時間", "票區／票種", "單張價格", "張數", "合計", "要求連位"]) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = title;
        header.append(cell);
    }

    const body = table.createTBody();
    const money = (value: number) => `NT$${value.toLocaleString("zh-TW")}`;

    draft.targets.forEach((target, index) => {
        const priceValid = Number.isSafeInteger(target.unitPrice) && target.unitPrice > 0;
        const quantityValid = Number.isSafeInteger(target.quantity) && target.quantity > 0;
        const total = target.unitPrice * target.quantity;

        const values = [
            index + 1,
            target.date || "未填寫",
            target.time || "未填寫",
            target.area.trim() || "未填寫",
            priceValid ? money(target.unitPrice) : "未填寫或無效",
            quantityValid ? target.quantity : "未填寫或無效",
            priceValid && quantityValid && Number.isSafeInteger(total) ? money(total) : "—",
            target.quantity === 1 ? "不適用（單張）" : target.adjacent ? "是" : "否",
        ];

        const row = body.insertRow();
        for (const value of values) {
            row.insertCell().textContent = String(value);
        }
    });

    scroll.append(table);
    root.append(heading, scroll);

    // 購買規則與排除關鍵字
    field("購買規則", "依順位嘗試，只購買其中一個符合條件的目標");
    field("排除關鍵字", draft.excludeKeywords.join("、") || "無");
}

async function saveActivity() {
    // 儲存活動設定，沿用已儲存的開賣時間
    const settings = activityInput(false);
    if (savedActivity?.saleSchedule) {
        settings.saleSchedule = structuredClone(savedActivity.saleSchedule);
    }
    const record = await api<ActivityRecord>(
        "/api/activities" + (selectedId ? "/" + selectedId : ""),
        selectedId ? "PUT" : "POST",
        settings,
    );

    // 更新目前編輯中的活動與列表
    selectedId = record.id;
    savedActivity = record.settings;
    savedRevision = record.updatedAt;
    activityBaseline = JSON.stringify(savedActivity);

    $("editorTitle").textContent = `編輯活動：${savedActivity.eventName}`;
    await list();
    summary();
}

async function action(fn: () => Promise<unknown>): Promise<void> {
    // 同一時間只執行一個操作
    if (actionBusy) {
        return;
    }
    actionBusy = true;
    updateHomeControls();

    // 保存期間鎖住表單，避免回應把後續尚未保存的編輯標成已保存。
    const inputs = [
        ...document.querySelectorAll<FormControl>(
            "#step1 input, #step1 select, #step1 button, #step1 textarea, #step2 input, #step2 select, #step2 button, #step3 input, #step3 select, #step3 button, nav button",
        ),
    ];
    const previous = inputs.map(input => input.disabled);
    inputs.forEach(input => {
        input.disabled = true;
    });

    // 執行操作，失敗時顯示錯誤；結束後還原表單
    try {
        $("message").textContent = "";
        await fn();
    } catch (error) {
        $("message").textContent = (error as Error).message;
    } finally {
        inputs.forEach((input, index) => {
            input.disabled = previous[index]!;
        });
        actionBusy = false;
        controls();
    }
}

$("new").onclick = () => {
    selectedId = "";
    savedActivity = null;
    savedRevision = "";
    resetRunView();

    loadForm({
        eventName: "",
        eventUrl: "",
        excludeKeywords: ["愛心席", "身障", "視線不良"],
        targets: [{ date: "", time: "", area: "", unitPrice: "", quantity: 1, adjacent: false }],
    });

    editing = true;
    activityBaseline = JSON.stringify(activityInput());

    $("editorTitle").textContent = "新增活動";
    $("summary").textContent = "請先儲存活動設定。";
    changed();
    showStep(1);
};

$("mode").onchange = () => {
    $("schedule").hidden = $("mode").value === "now";
    $("confirm").checked = false;
    summary();
    controls();
};

$("saveActivity").onclick = () =>
    action(async () => {
        await saveActivity();
        showStep(2);
    });

$("saveContact").onclick = () =>
    action(async () => {
        await api("/api/contact", "PUT", contactInput());
        contactReady = true;
        savedContactReady = true;
        contactBaseline = JSON.stringify(contactInput());

        $("confirm").checked = false;
        summary();
        showStep(3);
    });

// 修改表單時，要求重新確認；改聯絡資料也要重新儲存
for (const id of ["step1", "step2"] as const) {
    $(id).addEventListener("input", event => {
        if (["firstName", "lastName", "regionLabel", "phone", "email"].includes((event.target as HTMLElement).id)) {
            contactReady = false;
        }
        changed();
    });
}

// 修改開賣時間時，也要求重新確認並更新摘要
for (const id of ["saleAt", "advance"] as const) {
    $(id).addEventListener("input", () => {
        $("confirm").checked = false;
        summary();
        controls();
    });
}

async function fingerprint(value: unknown): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function begin(simulation: boolean): Promise<void> {
    requesting = true;
    controls();
    await action(async () => {
        // 確認設定已儲存，購票前也已勾選確認
        if (activityNeedsSave() || !contactReady || !selectedId) {
            throw Error("請先儲存並驗證完整設定。");
        }
        if (!simulation && !$("confirm").checked) {
            throw Error("請先確認購票摘要。");
        }

        // 同步取得使用者已確認的內容；後續不再讀取會改變的欄位。
        const activity = structuredClone(activityInput());
        const contact = structuredClone(contactInput());
        const signature = await fingerprint({ activity, contact });

        // 沿用尚未確認結果的請求（設定不同就停止）；沒有的話，設定有變更先儲存，再建立新請求
        const key = simulation ? "ticketpilot-simulation-request" : "ticketpilot-purchase-request";
        pendingRequest = JSON.parse(sessionStorage.getItem(key) || "null") as PendingRequest | null;
        if (pendingRequest && (pendingRequest.activityId !== selectedId || pendingRequest.signature !== signature)) {
            throw Error("上一筆開始請求結果尚待確認，不能更換設定或再次保存；請查看目前狀態。");
        }

        if (!pendingRequest) {
            if (JSON.stringify(activity) !== JSON.stringify(savedActivity)) {
                // 開始時間在第三步保存，版本核對避免覆蓋另一分頁的新設定。
                const record = await api<ActivityRecord>(
                    "/api/activities/" + selectedId,
                    "PUT",
                    activity,
                    savedRevision,
                );
                savedActivity = record.settings;
                savedRevision = record.updatedAt;
                activityBaseline = JSON.stringify(savedActivity);
                summary();
            }

            pendingRequest = { requestId: crypto.randomUUID(), activityId: selectedId, signature };
            sessionStorage.setItem(key, JSON.stringify(pendingRequest));
        }

        // 送出開始請求
        const request = { requestId: pendingRequest.requestId, activityId: pendingRequest.activityId };
        let result: PurchaseSnapshot | SimulationSnapshot;
        try {
            result = await api<PurchaseSnapshot | SimulationSnapshot>(
                simulation ? "/api/simulation" : "/api/purchase",
                "POST",
                simulation
                    ? { ...request, contact }
                    : { ...request, expectedActivity: activity, expectedContact: contact },
            );
        } catch (error) {
            // 只有伺服器確認未建立執行紀錄，才允許改用新的請求 ID。
            if ((error as ApiError).notAccepted) {
                sessionStorage.removeItem(key);
                pendingRequest = null;
            }
            throw error;
        }

        // 成功後清除請求紀錄，切到執行狀態
        sessionStorage.removeItem(key);
        pendingRequest = null;

        displayMode = simulation ? "simulation" : "purchase";
        displayedRun = { kind: displayMode, id: result.id };
        if (simulation) {
            renderSimulation(result as SimulationSnapshot);
        } else {
            render(result as PurchaseSnapshot);
        }
        showStep(4);
    });

    requesting = false;
    controls();
}

$("start").onclick = () => begin(false);

function renderLogs(events: PurchaseSnapshot["events"], truncated: boolean, introduction = ""): void {
    // 把事件轉成一行行紀錄
    const lines = events.flatMap(item => {
        const event = item.event;
        let message;
        if (event.type === "log") {
            message = event.message;
        } else if (event.type === "target") {
            message = `嘗試順位 ${event.index}/${event.total}：${event.date} ${event.time}／${event.area}／${event.quantity} 張／NT$${event.totalPrice}`;
        } else if (event.type === "recovery") {
            message = `恢復額度：排隊 ${event.queue}/1；預留 ${event.reservation}/1`;
        } else {
            return [];
        }

        return [new Date(item.at).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" }) + "  " + message];
    });

    // 顯示紀錄；使用者在看最新紀錄時，自動捲到最下面
    $("logs").textContent = introduction + (truncated ? "較早紀錄已省略。\n" : "") + lines.join("\n");
    if (followLog) {
        $("logs").scrollTop = $("logs").scrollHeight;
    }
}

function updateRunStatus() {
    // 只更新畫面上正在看的這次購票
    const run = currentRun;
    if (!run || displayedRun?.kind !== "purchase" || displayedRun.id !== run.id) {
        return;
    }

    const stateEvent = run.events.filter(item => item.event.type === "state").at(-1)?.event;
    const state = stateEvent?.type === "state" ? stateEvent.state : undefined;
    let title = "正在購票";
    let instruction = "程式正在依照設定執行，請稍候。";

    // 執行中：依目前狀態顯示提示
    if (run.status === "running") {
        if (state === "WAITING_FOR_LOGIN") {
            title = "請手動登入";
            instruction = "請到購票瀏覽器完成登入，完成後會自動繼續。";
        } else if (state === "WAITING_FOR_SALE") {
            title = "等待開賣";
            const saleAt = Date.parse(run.saleAt!);
            if (Number.isFinite(saleAt)) {
                const seconds = Math.max(0, Math.ceil((saleAt - Date.now()) / 1000));
                instruction =
                    `開賣時間：${new Date(saleAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}（台灣時間）。` +
                    (seconds > 0 ? `距開賣 ${seconds} 秒，程式會自動繼續。` : "已到設定時間，正在等待開賣頁面。");
            } else {
                instruction = "正在等待設定的開賣時間，程式會自動繼續。";
            }
        } else if (["MANUAL_REQUIRED", "FAILED"].includes(state!)) {
            title = "購票已停止";
            instruction = "請檢查購票瀏覽器的提示。程式正在完成停止處理，不會自動重新購票。";
        }
    } else {
        // 已結束：依結果顯示提示
        let ending: string;
        if (run.browserOpen) {
            ending = "檢查完成後請關閉購票瀏覽器，才能開始下一場。";
        } else if (run.occupied) {
            ending = "尚未確認程序正常結束，請先檢查原瀏覽器及執行紀錄。";
        } else {
            ending = "購票程序已結束，請先確認訂單狀態，再決定是否購買下一場。";
        }

        if (run.status === "payment-ready") {
            title = "已到付款頁";
            if (run.browserOpen) {
                instruction = "請到購票瀏覽器手動完成付款。完成後請關閉該瀏覽器，才能開始下一場。";
            } else if (run.occupied) {
                instruction = "購票瀏覽器已關閉，正在等待程序結束；本程式未核對付款結果。";
            } else {
                instruction = "購票瀏覽器已關閉。本程式未核對付款結果，請自行確認訂單。";
            }
        } else {
            title = "購票已停止";
            if (run.status === "unknown") {
                instruction = "提交結果尚未確認，請檢查購票頁面及訂單；程式不會重新提交。";
            } else if (run.status === "interrupted") {
                instruction = "程序異常中斷，請檢查原購票瀏覽器及訂單；程式不會自動重跑。";
            } else {
                instruction = "未能完成購票流程，請檢查購票瀏覽器的提示與執行紀錄；程式不會自動重新開始。";
            }
            instruction += ending;
        }

        if (closingBrowser) {
            instruction = "正在關閉購票瀏覽器，請稍候；確認程序結束後才會解除占用。";
        }
    }

    $("status").textContent = title;
    $("instruction").textContent = instruction;
}

function render(run: PurchaseSnapshot | null): void {
    // 記住最新的執行狀態
    if (!run) {
        return;
    }
    currentRun = run;
    occupied = run.occupied;

    // 狀態有變時，重新整理活動列表
    const stateEvent = run.events.filter(item => item.event.type === "state").at(-1)?.event;
    const lastState = stateEvent?.type === "state" ? stateEvent.state : undefined;
    const signature = JSON.stringify([run.id, run.status, lastState]);
    if (signature !== activityStatusSignature) {
        activityStatusSignature = signature;
        void list().catch(error => {
            $("message").textContent = (error as Error).message;
        });
    }

    // 不是正在看的這次購票，只更新按鈕
    if (displayedRun?.kind !== "purchase" || displayedRun.id !== run.id) {
        controls();
        return;
    }

    // 更新狀態與執行紀錄
    updateRunStatus();

    const recordedAt = run.events[0]?.at;
    const introduction =
        `本次活動：${run.activityName}\n` +
        (recordedAt
            ? `紀錄起始時間：${new Date(recordedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}\n`
            : "") +
        (run.status !== "running" && run.message ? `執行結果：${run.message}\n` : "");

    renderLogs(run.events, run.historyTruncated, introduction);
    controls();
}

function renderSimulation(run: SimulationSnapshot | null): void {
    // 記住最新模擬狀態
    if (!run) {
        return;
    }
    latestSimulation = run;
    simulationRunning = run.status === "running";

    // 只更新目前正在看的這次模擬
    if (displayedRun?.kind === "simulation" && displayedRun.id === run.id) {
        if (simulationRunning) {
            $("status").textContent = "模擬執行中";
        } else if (run.status === "completed") {
            $("status").textContent = "模擬完成（未購票）";
        } else {
            $("status").textContent = "模擬中斷";
        }
        $("instruction").textContent = "模擬不連線網站、不建立訂單。";
        renderLogs(run.events, run.historyTruncated, "模擬執行紀錄（不購票）\n");
    }

    // 同步按鈕是否可操作
    controls();
}

$("closeBrowser").onclick = async () => {
    // 確認這次購票可以關閉瀏覽器，並請使用者確認
    if (
        closingBrowser ||
        displayedRun?.kind !== "purchase" ||
        displayedRun.id !== currentRun?.id ||
        !currentRun?.canCloseBrowser
    ) {
        return;
    }
    const runId = currentRun.id;
    const prompt =
        currentRun.status === "payment-ready"
            ? "關閉購票瀏覽器後將離開付款頁。請確認已完成付款，或確定不再付款，再關閉。"
            : "關閉購票瀏覽器？請先確認已檢查頁面及訂單狀態。";
    if (!window.confirm(prompt)) {
        return;
    }

    // 送出關閉請求，完成後更新畫面
    closingBrowser = true;
    updateRunStatus();
    controls();

    try {
        $("message").textContent = "";
        const result = await api<PurchaseSnapshot>("/api/purchase/close-browser", "POST", { runId });
        // 等待關閉期間可能已收到新狀態，不用舊回應覆蓋另一輪。
        if (currentRun?.id === runId) {
            render(result as PurchaseSnapshot);
        }
    } catch (error) {
        $("message").textContent = (error as Error).message;
    } finally {
        closingBrowser = false;
        updateRunStatus();
        controls();
    }
};

$("logs").onscroll = () => {
    followLog = $("logs").scrollHeight - $("logs").scrollTop - $("logs").clientHeight < 30;
};

$("copy").onclick = () => action(() => navigator.clipboard.writeText($("logs").textContent!));

setInterval(updateRunStatus, 1e3);

function subscribe<T>(path: string, receive: (run: T) => void): void {
    const stream = new EventSource(path + "?token=" + encodeURIComponent(token));
    stream.onmessage = e => receive(JSON.parse(e.data));
    stream.onerror = () => {
        $("message").textContent = "狀態連線中斷，正在重新連線；不會重新開始購票。";
    };
}

subscribe("/api/purchase/events", render);
subscribe("/api/events", renderSimulation);

// 頁面開啟時：建立第一列順位、載入活動列表、聯絡資料與購票狀態
(async () => {
    row();
    await list();

    const data = await api<{ contact: ContactDetails | null }>("/api/contact");
    if (data.contact) {
        for (const [id, value] of Object.entries(data.contact) as [keyof ContactDetails, string][]) {
            if (id === "regionLabel" && ![...$(id).options].some(o => o.value === value)) {
                $(id).append(new Option(value, value));
            }
            $(id).value = value;
        }
        contactReady = true;
    }

    contactBaseline = JSON.stringify(contactInput());
    savedContactReady = contactReady;

    const run = await api<PurchaseSnapshot | null>("/api/purchase");
    if (run) {
        render(run);
    }
    controls();
})().catch(error => {
    $("message").textContent = (error as Error).message;
});
