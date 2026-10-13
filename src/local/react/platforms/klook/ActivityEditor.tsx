import { emptyTarget } from "./formModel.js";
import type { ActivityForm, TargetDraft } from "./formModel.js";

interface Props {
    form: ActivityForm;
    title: string;
    disabled: boolean;
    onChange: (form: ActivityForm) => void;
    onSave: () => void;
}

export function ActivityEditor({ form, title, disabled, onChange, onSave }: Props) {
    const change = (patch: Partial<ActivityForm>) => onChange({ ...form, ...patch });
    const legacy = !form.bundleEnabled && Boolean(form.deliveryMethod.trim());
    const updateTarget = (index: number, patch: Partial<TargetDraft>) => {
        change({ targets: form.targets.map((target, i) => (i === index ? { ...target, ...patch } : target)) });
    };

    function move(index: number, offset: number) {
        const destination = index + offset;
        if (destination < 0 || destination >= form.targets.length) return;
        const targets = [...form.targets];
        [targets[index], targets[destination]] = [targets[destination]!, targets[index]!];
        change({ targets });
    }

    return (
        <div className="card">
            <div className="section-title">
                <h2 id="editorTitle">{title}</h2>
            </div>
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
                    placeholder="https://www.klook.com/zh-TW/event-detail/…/"
                />
            </label>
            <fieldset className="feature-settings" disabled={disabled}>
                <legend>功能啟用</legend>
                <label className="check">
                    <input
                        id="queueEnabled"
                        type="checkbox"
                        checked={form.queueEnabled}
                        onChange={e => change({ queueEnabled: e.target.checked })}
                    />
                    排隊流程
                </label>
                <label className="check">
                    <input
                        id="bundleEnabled"
                        type="checkbox"
                        checked={form.bundleEnabled}
                        onChange={e =>
                            change(
                                e.target.checked
                                    ? { bundleEnabled: true }
                                    : {
                                          bundleEnabled: false,
                                          deliveryMethod: "",
                                          targets: form.targets.map(target => ({ ...target, bundle: "" })),
                                      },
                            )
                        }
                    />
                    組合套票
                </label>
            </fieldset>
            <div id="bundleSettings">
                <label>
                    取票方式（選填）
                    <input
                        id="deliveryMethod"
                        disabled={disabled || !form.bundleEnabled}
                        value={form.deliveryMethod}
                        onChange={e => change({ deliveryMethod: e.target.value })}
                        placeholder="例如：指定地點自取"
                    />
                </label>
                <div id="legacyDelivery" hidden={!legacy}>
                    <p>此活動有未啟用套票的舊取票設定。請啟用套票並補齊各順位，或清除舊取票設定後再儲存及開始。</p>
                    <button
                        id="clearLegacyDelivery"
                        className="secondary"
                        disabled={disabled}
                        onClick={() => change({ deliveryMethod: "" })}
                    >
                        清除舊取票設定
                    </button>
                </div>
            </div>
            <div className="section-title">
                <div>
                    <h2>購票順位</h2>
                    <p>由上往下嘗試，只接受你指定的目標。</p>
                </div>
                <button
                    id="add"
                    className="secondary"
                    disabled={disabled}
                    onClick={() => change({ targets: [...form.targets, emptyTarget()] })}
                >
                    新增順位
                </button>
            </div>
            <div id="targets">
                {form.targets.map((target, index) => (
                    <div className="target-row" key={target.key}>
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
                                票區／票種
                                <input
                                    name="area"
                                    required
                                    disabled={disabled}
                                    value={target.area}
                                    onChange={e => updateTarget(index, { area: e.target.value })}
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
                                    onChange={e =>
                                        updateTarget(index, {
                                            quantity: e.target.value,
                                            adjacent: Number(e.target.value) <= 1 ? false : target.adjacent,
                                        })
                                    }
                                />
                            </label>
                        </div>
                        <label className="bundle-field" hidden={!form.bundleEnabled}>
                            組合套票
                            <input
                                name="bundle"
                                required={form.bundleEnabled}
                                disabled={disabled || !form.bundleEnabled}
                                value={target.bundle}
                                onChange={e => updateTarget(index, { bundle: e.target.value })}
                                placeholder="例如：演唱會套票 1"
                            />
                        </label>
                        <div className="target-tools">
                            <strong className="position">順位 {index + 1}</strong>
                            <label className="check">
                                <input
                                    name="adjacent"
                                    type="checkbox"
                                    disabled={disabled || Number(target.quantity) <= 1}
                                    checked={target.adjacent}
                                    onChange={e => updateTarget(index, { adjacent: e.target.checked })}
                                />
                                要求連位
                            </label>
                            <button className="secondary up" disabled={disabled} onClick={() => move(index, -1)}>
                                上移
                            </button>
                            <button className="secondary down" disabled={disabled} onClick={() => move(index, 1)}>
                                下移
                            </button>
                            <button
                                className="secondary remove"
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
                                className="secondary duplicate"
                                disabled={disabled}
                                onClick={() =>
                                    change({
                                        targets: [
                                            ...form.targets.slice(0, index + 1),
                                            { ...target, key: crypto.randomUUID(), bundle: target.bundle.trim() },
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
            <details>
                <summary>進階設定 · 嚴格順位</summary>
                <p>STRICT：不購買清單以外的票種。</p>
                <label>
                    排除關鍵字（以逗號分隔）
                    <input
                        id="exclude"
                        disabled={disabled}
                        value={form.exclude}
                        onChange={e => change({ exclude: e.target.value })}
                    />
                </label>
            </details>
            <footer>
                <button id="saveActivity" disabled={disabled} onClick={onSave}>
                    下一步
                </button>
            </footer>
        </div>
    );
}
