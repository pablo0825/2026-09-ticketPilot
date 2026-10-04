const $ = (id) => document.getElementById(id);
let selectedId = "", savedActivity = null, contactReady = false, dirty = true;
let displayMode = "purchase";
let editing = false, actionBusy = false, activityBaseline = "", contactBaseline = "", savedContactReady = false;
let startedRunId = "", latestSimulation = null;
let occupied = false, simulationRunning = false, requesting = false, pendingRequest = null, currentRun = null, followLog = true;
const names = { STARTING: "啟動中", LOGIN_CHECK: "確認登入", WAITING_FOR_LOGIN: "等待手動登入", WAITING_FOR_SALE: "等待開賣", SALE_REFRESH: "刷新開賣頁面", READY: "準備完成", EVENT_PAGE: "核對活動頁", TICKET_SELECTION: "依順位選票", SELECTION_VERIFIED: "選票核對完成", SEAT_ASSIGNMENT: "等待配位", SEATS_VERIFIED: "配位核對完成", SEAT_CONFIRMATION: "確認座位", PERSONAL_INFO_READY: "已到個人資料頁", BOOKING_VERIFIED: "訂單摘要核對完成", CONTACT_FILLING: "填寫聯絡資料", CONTACT_VERIFIED: "聯絡資料核對完成", CONTACT_SUBMISSION: "提交聯絡資料", PAYMENT_READY: "已到付款頁，請手動付款", RECOVERING: "處理已知逾期", MANUAL_REQUIRED: "需要人工檢查", FAILED: "流程停止" };
async function api(path, method = "GET", value) {
    const response = await fetch(path, { method, headers: { "X-Local-Token": token, "Content-Type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value) });
    const data = await response.json();
    if (!response.ok) {
        const error = Error(data.error);
        error.notAccepted = data.notAccepted === true;
        throw error;
    }
    return data;
}
function showStep(step) {
    document.querySelectorAll("main > section").forEach((el) => el.hidden = el.id !== `step${step}`);
    document.querySelector("nav").hidden = !editing;
    $("homeButton").hidden = false;
    $("purchaseSummary").hidden = !editing;
    document.querySelectorAll("nav button").forEach((el) => el.classList.toggle("active", el.dataset.step === String(step)));
}
document.querySelectorAll("nav button").forEach((button) => button.onclick = () => showStep(button.dataset.step));
function controls() {
    $("start").disabled = !editing || actionBusy || occupied || simulationRunning || requesting || dirty || !contactReady || !$("confirm").checked;
    $("simulate").disabled = !editing || actionBusy || occupied || simulationRunning || requesting || dirty || !contactReady;
    updateHomeControls();
}
function updateHomeStatus() {
    // 首頁只顯示需要處理的目前狀態；紀錄仍留在第三步及本機。
    $("homeRun").hidden = true;
    $("homeRun").textContent = "";
    $("viewRun").hidden = true;
    if (occupied) {
        $("homeRun").hidden = false;
        $("viewRun").hidden = false;
        $("viewRun").textContent = "查看目前狀態";
        $("homeRun").textContent = currentRun?.status === "payment-ready"
            ? "自動流程已完成，瀏覽器仍占用中；請完成付款並關閉購票瀏覽器。"
            : currentRun?.status === "running"
                ? "購票流程執行中，不能開始另一輪或刪除活動。"
                : "購票程序或瀏覽器仍占用中，請查看目前狀態並人工檢查。";
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
    document.querySelectorAll("#activities button").forEach(button => button.disabled = blocked);
    $("homeButton").disabled = actionBusy || requesting;
    $("viewRun").disabled = actionBusy || requesting;
}
function hasUnsavedChanges() {
    if (!editing) return false;
    try { return JSON.stringify(activityInput()) !== activityBaseline || JSON.stringify(contactInput()) !== contactBaseline; }
    catch { return true; }
}
function allowLeave() {
    return !hasUnsavedChanges() || window.confirm("有尚未儲存的修改，要放棄並返回活動首頁嗎？");
}
async function goHome() {
    if (!allowLeave()) return;
    editing = false;
    startedRunId = "";
    if (currentRun) render(currentRun);
    selectedId = "";
    savedActivity = null;
    dirty = true;
    $("confirm").checked = false;
    if (contactBaseline) {
        for (const [id, value] of Object.entries(JSON.parse(contactBaseline))) $(id).value = value;
        contactReady = savedContactReady;
    }
    document.querySelectorAll("main > section").forEach(el => el.hidden = el.id !== "home");
    document.querySelector("nav").hidden = true;
    $("homeButton").hidden = true;
    await action(list);
}
$("homeButton").onclick = goHome;
$("viewRun").onclick = () => {
    if (latestSimulation && !occupied && (simulationRunning || displayMode === "simulation")) {
        displayMode = "simulation";
        renderSimulation(latestSimulation);
    } else {
        displayMode = "purchase";
        render(currentRun);
    }
    showStep(3);
};
function changed() {
    dirty = true;
    $("confirm").checked = false;
    controls();
}
$("confirm").onchange = controls;
function row(data = { date: "", time: "", area: "", unitPrice: "", quantity: 1, adjacent: false }) {
    const container = document.createElement("div");
    container.className = "target-row";
    container.innerHTML = '<div class="target-fields"><label>演出日期<input name="date" type="date" required></label><label>演出時間<input name="time" type="time" required></label><label>票區／票種<input name="area" required></label><label>單張價格（NT$）<input name="unitPrice" type="number" min="1" step="1" required></label><label>張數<input name="quantity" type="number" min="1" step="1" required></label></div><div class="target-tools"><strong class="position"></strong><label class="check"><input name="adjacent" type="checkbox">要求連位</label><button type="button" class="secondary up">上移</button><button type="button" class="secondary down">下移</button><button type="button" class="secondary remove">移除</button></div>';
    for (const [key, value] of Object.entries(data)) {
        const input = container.querySelector(`[name="${key}"]`);
        if (input) key === "adjacent" ? input.checked = value : input.value = value;
    }
    const quantity = container.querySelector('[name="quantity"]'), adjacent = container.querySelector('[name="adjacent"]');
    const sync = () => {
        adjacent.disabled = Number(quantity.value) <= 1;
        if (adjacent.disabled) adjacent.checked = false;
    };
    sync();
    quantity.addEventListener("input", sync);
    container.querySelector(".up").onclick = () => {
        if (container.previousElementSibling) container.before(container.previousElementSibling);
        renumber();
        changed();
    };
    container.querySelector(".down").onclick = () => {
        if (container.nextElementSibling) container.after(container.nextElementSibling);
        renumber();
        changed();
    };
    container.querySelector(".remove").onclick = () => {
        if ($("targets").children.length > 1) {
            container.remove();
            renumber();
            changed();
        }
    };
    $("targets").append(container);
    renumber();
}
function renumber() {
    [...$("targets").children].forEach((el, i) => el.querySelector(".position").textContent = `順位 ${i + 1}`);
}
$("add").onclick = () => {
    row();
    changed();
};
function loadForm(settings) {
    $("eventName").value = settings.eventName;
    $("eventUrl").value = settings.eventUrl;
    $("exclude").value = settings.excludeKeywords.join(",");
    $("targets").replaceChildren();
    settings.targets.forEach(row);
    $("mode").value = settings.saleSchedule ? "scheduled" : "now";
    $("saleAt").value = settings.saleSchedule?.saleAt.slice(0, 19) ?? "";
    $("advance").value = settings.saleSchedule?.advanceSeconds ?? 1;
    $("schedule").hidden = $("mode").value === "now";
    $("confirm").checked = false;
}
function activityInput() {
    const targets = [...$("targets").children].map((el) => Object.fromEntries([...el.querySelectorAll("[name]")].map((input) => [input.name, input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value])));
    const settings = { eventUrl: $("eventUrl").value.trim(), eventName: $("eventName").value.trim(), fallbackMode: "STRICT", excludeKeywords: $("exclude").value.split(/[,，]/).map((v) => v.trim()).filter(Boolean), targets };
    if ($("mode").value === "scheduled") {
        const raw = $("saleAt").value;
        if (!raw) throw Error("請填寫開賣時間。");
        settings.saleSchedule = { saleAt: (raw.length === 16 ? raw + ":00" : raw) + "+08:00", advanceSeconds: Number($("advance").value) };
    }
    return settings;
}
function contactInput() {
    return Object.fromEntries(["firstName", "lastName", "regionLabel", "phone", "email"].map((id) => [id, $(id).value.trim()]));
}
async function list() {
    const data = await api("/api/activities");
    $("activities").replaceChildren();
    $("emptyActivities").hidden = data.activities.length > 0;
    for (const item of data.activities) {
        const tr = document.createElement("tr");
        const sessions = [...new Set(item.settings.targets.map(target => `${target.date} ${target.time}`))];
        const first = item.settings.targets[0];
        for (const text of [item.settings.eventName, sessions.length === 1 ? first.date : "多個場次", sessions.length === 1 ? first.time : "多個場次"]) {
            const td = document.createElement("td");
            td.textContent = text;
            tr.append(td);
        }
        const actions = document.createElement("td");
        const use = document.createElement("button");
        use.textContent = "使用活動";
        use.onclick = () => action(async () => {
            const record = await api("/api/activities/" + item.id);
            selectedId = record.id;
            savedActivity = record.settings;
            editing = true;
            loadForm(savedActivity);
            activityBaseline = JSON.stringify(activityInput());
            dirty = false;
            $("editorTitle").textContent = `編輯活動：${savedActivity.eventName}`;
            $("saveActivity").textContent = "儲存變更，下一步";
            summary();
            showStep(1);
        });
        const remove = document.createElement("button");
        remove.className = "secondary";
        remove.textContent = "刪除";
        remove.onclick = () => {
            if (!window.confirm(`刪除「${item.settings.eventName}」的活動設定？聯絡資料及執行紀錄會保留。`)) return;
            action(async () => { await api("/api/activities/" + item.id, "DELETE"); await list(); });
        };
        actions.append(use, remove);
        tr.append(actions);
        $("activities").append(tr);
    }
    updateHomeControls();
    if (data.invalidFiles) $("message").textContent = `${data.invalidFiles} 個設定檔無法載入，未覆寫。`;
}
function summary() {
    if (!savedActivity) return;
    $("summary").textContent = `${savedActivity.eventName}
${savedActivity.eventUrl}

` + savedActivity.targets.map((t, i) => `${i + 1}. ${t.date} ${t.time}｜${t.area}｜NT$${t.unitPrice} × ${t.quantity} = NT$${t.unitPrice * t.quantity}${t.adjacent ? "｜要求連位" : ""}`).join("\n") + `

${savedActivity.saleSchedule ? "開賣：" + savedActivity.saleSchedule.saleAt + "，提前 " + (savedActivity.saleSchedule.advanceSeconds ?? 1) + " 秒刷新" : "立即開始"}
只接受指定順位；排除：${savedActivity.excludeKeywords.join("、") || "無"}`;
}
async function saveActivity() {
    const settings = activityInput();
    const record = await api("/api/activities" + (selectedId ? "/" + selectedId : ""), selectedId ? "PUT" : "POST", settings);
    selectedId = record.id;
    savedActivity = record.settings;
    activityBaseline = JSON.stringify(activityInput());
    $("editorTitle").textContent = `編輯活動：${savedActivity.eventName}`;
    $("saveActivity").textContent = "儲存變更，下一步";
    await list();
    summary();
}
async function action(fn) {
    if (actionBusy) return;
    actionBusy = true;
    updateHomeControls();
    // 保存期間鎖住表單，避免回應把後續尚未保存的編輯標成已保存。
    const inputs = [...document.querySelectorAll("#step1 input, #step1 select, #step1 button, #step1 textarea, #step2 input, #step2 select, #step2 button, nav button")];
    const previous = inputs.map((input) => input.disabled);
    inputs.forEach((input) => input.disabled = true);
    try {
        $("message").textContent = "";
        await fn();
    } catch (error) {
        $("message").textContent = error.message;
    } finally {
        inputs.forEach((input, index) => input.disabled = previous[index]);
        actionBusy = false;
        controls();
    }
}
$("new").onclick = () => {
    selectedId = "";
    savedActivity = null;
    loadForm({ eventName: "", eventUrl: "", excludeKeywords: ["愛心席", "身障", "視線不良"], targets: [{ date: "", time: "", area: "", unitPrice: "", quantity: 1, adjacent: false }] });
    editing = true;
    activityBaseline = JSON.stringify(activityInput());
    $("editorTitle").textContent = "新增活動";
    $("saveActivity").textContent = "儲存活動，下一步";
    $("summary").textContent = "請先儲存活動設定。";
    changed();
    showStep(1);
};
$("mode").onchange = () => {
    $("schedule").hidden = $("mode").value === "now";
    changed();
};
$("saveActivity").onclick = () => action(async () => {
    await saveActivity();
    dirty = false;
    showStep(2);
});
$("saveContact").onclick = () => action(async () => {
    await saveActivity();
    await api("/api/contact", "PUT", contactInput());
    contactReady = true;
    savedContactReady = true;
    contactBaseline = JSON.stringify(contactInput());
    dirty = false;
    $("confirm").checked = false;
    showStep(3);
});
for (const id of ["step1", "step2"]) $(id).addEventListener("input", (event) => {
    if (["firstName", "lastName", "regionLabel", "phone", "email"].includes(event.target.id)) contactReady = false;
    changed();
});
async function begin(simulation) {
    requesting = true;
    controls();
    await action(async () => {
        if (dirty || !contactReady || !selectedId) throw Error("請先儲存並驗證完整設定。");
        if (!simulation && !$("confirm").checked) throw Error("請先確認購票摘要。");
        const key = simulation ? "ticketpilot-simulation-request" : "ticketpilot-purchase-request";
        pendingRequest = JSON.parse(sessionStorage.getItem(key) || "null") ?? { requestId: crypto.randomUUID(), activityId: selectedId };
        if (pendingRequest.activityId !== selectedId) throw Error("上一筆開始請求結果尚待確認，請重新整理查看執行狀態。");
        // 網路回應遺失仍保留同一 ID，重送只讀取既有結果。
        sessionStorage.setItem(key, JSON.stringify(pendingRequest));
        let result;
        try {
            result = await api(simulation ? "/api/simulation" : "/api/purchase", "POST", simulation ? { ...pendingRequest, contact: contactInput() } : { ...pendingRequest, expectedActivity: savedActivity, expectedContact: contactInput() });
        } catch (error) {
            // 只有伺服器確認未建立執行紀錄，才允許改用新的請求 ID。
            if (error.notAccepted) {
                sessionStorage.removeItem(key);
                pendingRequest = null;
            }
            throw error;
        }
        sessionStorage.removeItem(key);
        pendingRequest = null;
        displayMode = simulation ? "simulation" : "purchase";
        if (!simulation) startedRunId = result.id;
        simulation ? renderSimulation(result) : render(result);
        showStep(3);
    });
    requesting = false;
    controls();
}
$("start").onclick = () => begin(false);
$("simulate").onclick = () => begin(true);
function renderLogs(events, truncated) {
    $("logs").textContent = (truncated ? "較早紀錄已省略。\n" : "") + events.filter((item) => item.event.type === "log").map((item) => new Date(item.at).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei" }) + "  " + item.event.message).join("\n");
    if (followLog) $("logs").scrollTop = $("logs").scrollHeight;
}
function render(run) {
    if (!run) return;
    currentRun = run;
    occupied = run.occupied;
    const recordedAt = run.events[0]?.at;
    const label = `${run.activityName} · ${recordedAt ? new Date(recordedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : "時間未記錄"}`;
    if (displayMode === "simulation" && !occupied) {
        controls();
        return;
    }
    $("runLabel").textContent = `${run.id === startedRunId ? "本次執行" : occupied ? "目前占用狀態" : "上次執行紀錄"}：${label}`;
    const states = run.events.filter((e) => e.event.type === "state");
    const state = states.at(-1)?.event.state;
    $("status").textContent = run.status === "running" ? names[state] || "準備啟動" : run.status === "payment-ready" ? "已到付款頁，請手動付款" : run.status === "unknown" ? "提交結果待確認" : run.status === "interrupted" ? "程序中斷" : "購票已停止";
    $("instruction").textContent = state === "WAITING_FOR_LOGIN" && run.status === "running" ? "請在購票瀏覽器手動登入，完成後自動繼續。" : run.message;
    $("browser").textContent = run.occupied ? "購票程序／瀏覽器仍占用中，不能開始下一場。" : "購票程序已結束。請先確認訂單狀態，再決定是否購買下一場。";
    const target = run.events.filter((e) => e.event.type === "target").at(-1)?.event;
    if (target) $("target").textContent = `順位 ${target.index}/${target.total}：${target.area} ${target.quantity} 張，NT$${target.totalPrice}`;
    const budget = run.events.filter((e) => e.event.type === "recovery").at(-1)?.event;
    $("budget").textContent = `排隊恢復 ${budget?.queue ?? 0}/1；預留恢復 ${budget?.reservation ?? 0}/1`;
    renderLogs(run.events, run.historyTruncated);
    controls();
}
function renderSimulation(run) {
    if (!run) return;
    latestSimulation = run;
    simulationRunning = run.status === "running";
    if (!occupied && (displayMode === "simulation" || !currentRun)) {
        $("runLabel").textContent = "模擬執行紀錄（不購票）";
        $("target").textContent = "順位：—";
        $("budget").textContent = "恢復：—";
        $("browser").textContent = "";
        $("status").textContent = simulationRunning ? "模擬執行中" : run.status === "completed" ? "模擬完成（未購票）" : "模擬中斷";
        $("instruction").textContent = "模擬不連線網站、不建立訂單。";
        renderLogs(run.events, run.historyTruncated);
    }
    controls();
}
$("logs").onscroll = () => {
    followLog = $("logs").scrollHeight - $("logs").scrollTop - $("logs").clientHeight < 30;
};
$("latest").onclick = () => {
    followLog = true;
    $("logs").scrollTop = $("logs").scrollHeight;
};
$("copy").onclick = () => action(() => navigator.clipboard.writeText($("logs").textContent));
setInterval(() => {
    $("countdown").textContent = currentRun?.status === "running" && currentRun.saleAt ? `距開賣：${Math.max(0, Math.ceil((Date.parse(currentRun.saleAt) - Date.now()) / 1e3))} 秒` : "";
}, 1e3);
function subscribe(path, receive) {
    const stream = new EventSource(path + "?token=" + encodeURIComponent(token));
    stream.onmessage = (e) => receive(JSON.parse(e.data));
    stream.onerror = () => {
        $("message").textContent = "狀態連線中斷，正在重新連線；不會重新開始購票。";
    };
}
subscribe("/api/purchase/events", render);
subscribe("/api/events", renderSimulation);
(async () => {
    row();
    await list();
    const data = await api("/api/contact");
    if (data.contact) {
        for (const [id, value] of Object.entries(data.contact)) {
            if (id === "regionLabel" && ![...$(id).options].some((o) => o.value === value)) $(id).append(new Option(value, value));
            $(id).value = value;
        }
        contactReady = true;
    }
    contactBaseline = JSON.stringify(contactInput());
    savedContactReady = contactReady;
    const run = await api("/api/purchase");
    if (run) {
        render(run);
    }
    controls();
})().catch((error) => $("message").textContent = error.message);
