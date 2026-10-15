import { emptyTarget } from "./formModel.js";
import type { ActivityForm, TargetDraft } from "./formModel.js";
import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";

interface Props {
    form: ActivityForm;
    saved?: TicketPlusActivitySettings;
    disabled: boolean;
    onChange: (form: ActivityForm) => void;
    onSave: () => void;
}

export function ActivityEditor({ form, saved, disabled, onChange, onSave }: Props) {
    const change = (patch: Partial<ActivityForm>) => onChange({ ...form, ...patch });
    const updateTarget = (index: number, patch: Partial<TargetDraft>) => {
        change({ targets: form.targets.map((target, i) => (i === index ? { ...target, ...patch } : target)) });
    };
    const sessions = new Set(
        form.targets.filter(target => target.date && target.time).map(target => `${target.date} ${target.time}`),
    );
    function move(index: number, offset: number) {
        const destination = index + offset;
        if (destination < 0 || destination >= form.targets.length) return;
        const targets = [...form.targets];
        [targets[index], targets[destination]] = [targets[destination]!, targets[index]!];
        change({ targets });
    }

    return (
        <form
            className="card"
            onSubmit={event => {
                event.preventDefault();
                onSave();
            }}
        >
            <h2>{saved ? `編輯活動：${saved.eventName}` : "新增活動"}</h2>
            <label>
                活動名稱
                <input
                    id="eventName"
                    required
                    disabled={disabled}
                    value={form.eventName}
                    onChange={e => change({ eventName: e.target.value })}
                    placeholder="輸入官網活動完整名稱"
                />
            </label>
            <label>
                活動網址
                <input
                    id="eventUrl"
                    type="url"
                    required
                    disabled={disabled}
                    value={form.eventUrl}
                    onChange={e => change({ eventUrl: e.target.value })}
                    placeholder="https://ticketplus.com.tw/activity/…"
                />
            </label>
            <div className="section-title">
                <div>
                    <h2>購票順位</h2>
                    <p>由上往下嘗試，票種名稱需與頁面一致。</p>
                </div>
                <button
                    type="button"
                    id="add"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => change({ targets: [...form.targets, emptyTarget()] })}
                >
                    新增順位
                </button>
            </div>
            <p>目前購票流程只支援同日期、同時間的多順位；儲存不會啟動購票，請另行核對摘要並開始。</p>
            {sessions.size > 1 && <p role="status">此設定含不同場次，可以儲存，但目前無法啟動購票。</p>}
            <div id="targets">
                {form.targets.map((target, index) => (
                    <div className="target-row" key={target.key} role="group" aria-label={`順位 ${index + 1}`}>
                        <div className="target-fields">
                            <label>
                                演出日期
                                <input
                                    name="date"
                                    type="date"
                                    required
                                    disabled={disabled}
                                    value={target.date}
                                    onChange={e => updateTarget(index, { date: e.target.value })}
                                />
                            </label>
                            <label>
                                演出時間
                                <input
                                    name="time"
                                    type="time"
                                    required
                                    disabled={disabled}
                                    value={target.time}
                                    onChange={e => updateTarget(index, { time: e.target.value })}
                                />
                            </label>
                            <label>
                                票種名稱
                                <input
                                    name="ticketType"
                                    required
                                    disabled={disabled}
                                    value={target.ticketType}
                                    onChange={e => updateTarget(index, { ticketType: e.target.value })}
                                    placeholder="例如：預售票"
                                />
                            </label>
                            <label>
                                張數
                                <input
                                    name="quantity"
                                    type="number"
                                    min="1"
                                    step="1"
                                    required
                                    disabled={disabled}
                                    value={target.quantity}
                                    onChange={e => updateTarget(index, { quantity: e.target.value })}
                                />
                            </label>
                        </div>
                        <div className="target-tools">
                            <strong className="position">順位 {index + 1}</strong>
                            <button
                                type="button"
                                className="secondary"
                                disabled={disabled || index === 0}
                                onClick={() => move(index, -1)}
                            >
                                上移
                            </button>
                            <button
                                type="button"
                                className="secondary"
                                disabled={disabled || index === form.targets.length - 1}
                                onClick={() => move(index, 1)}
                            >
                                下移
                            </button>
                            <button
                                type="button"
                                className="secondary"
                                disabled={disabled}
                                onClick={() =>
                                    change({
                                        targets:
                                            form.targets.length === 1
                                                ? [emptyTarget()]
                                                : form.targets.filter((_, i) => i !== index),
                                    })
                                }
                            >
                                {form.targets.length === 1 ? "清空" : "移除"}
                            </button>
                            <button
                                type="button"
                                className="secondary"
                                disabled={disabled}
                                onClick={() =>
                                    change({
                                        targets: [
                                            ...form.targets.slice(0, index + 1),
                                            { ...target, key: crypto.randomUUID() },
                                            ...form.targets.slice(index + 1),
                                        ],
                                    })
                                }
                            >
                                複製
                            </button>
                        </div>
                    </div>
                ))}
            </div>
            <label>
                最長執行時間（分鐘，選填）
                <input
                    id="maxRunMinutes"
                    type="number"
                    min="1"
                    max="1440"
                    step="1"
                    disabled={disabled}
                    value={form.maxRunMinutes}
                    onChange={e => change({ maxRunMinutes: e.target.value })}
                />
            </label>
            <p>從人工登入交接完成後開始計時。留空不設全程期限，各操作仍有自己的逾時限制。</p>
            {saved?.saleSchedule && (
                <div role="note">
                    <h3>已保存的開賣設定（唯讀）</h3>
                    <p>
                        開賣時間：{saved.saleSchedule.saleAt}；提前刷新：{saved.saleSchedule.advanceSeconds} 秒。
                    </p>
                    <p>此次儲存會保留原設定。開賣等待與提前刷新尚未接通，帶此設定的活動目前無法啟動購票。</p>
                </div>
            )}
            <footer>
                <button id="saveActivity" type="submit" disabled={disabled}>
                    儲存活動
                </button>
            </footer>
        </form>
    );
}
