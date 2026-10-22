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
            <h2>{saved ? "編輯活動" : "新增活動"}</h2>
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
            <fieldset className="feature-settings" disabled={disabled}>
                <legend>購票流程</legend>
                <label className="check">
                    <input
                        id="flowPurchase"
                        type="radio"
                        name="flowType"
                        checked={form.flowType === "purchase"}
                        onChange={() => change({ flowType: "purchase" })}
                    />
                    購票
                </label>
                <label className="check">
                    <input
                        id="flowLottery"
                        type="radio"
                        name="flowType"
                        checked={form.flowType === "lottery"}
                        onChange={() => change({ flowType: "lottery" })}
                    />
                    登記抽選
                </label>
            </fieldset>
            <div className="section-title">
                <h2>購票順位</h2>
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
            {sessions.size > 1 && <p role="status">此設定含不同場次，可以儲存，但目前無法啟動購票。</p>}
            <div id="targets">
                {form.targets.map((target, index) => (
                    <div className="target-row" key={target.key} role="group" aria-label={`順位 ${index + 1}`}>
                        <h3 className="ticketplus-target-title">順位 {index + 1}</h3>
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
            <footer>
                <button id="saveActivity" type="submit" disabled={disabled}>
                    儲存活動
                </button>
            </footer>
        </form>
    );
}
