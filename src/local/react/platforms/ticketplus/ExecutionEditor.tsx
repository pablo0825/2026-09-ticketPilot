import type { ExecutionForm } from "./formModel.js";

interface Props {
    form: ExecutionForm;
    disabled: boolean;
    activityDirty: boolean;
    onChange: (form: ExecutionForm) => void;
}

export function ExecutionEditor({ form, disabled, activityDirty, onChange }: Props) {
    return (
        <div>
            <h3>執行設定</h3>
            <label>
                執行方式
                <select
                    value={form.mode}
                    disabled={disabled}
                    onChange={event =>
                        onChange(
                            event.target.value === "now"
                                ? { mode: "now", saleAt: "", maxRunMinutes: form.maxRunMinutes }
                                : { ...form, mode: "scheduled" },
                        )
                    }
                >
                    <option value="now">立即開始</option>
                    <option value="scheduled">指定開賣時間</option>
                </select>
            </label>
            {form.mode === "scheduled" && (
                <>
                    <label>
                        開賣時間（台灣 UTC+8）
                        <input
                            type="datetime-local"
                            step="1"
                            disabled={disabled}
                            value={form.saleAt}
                            onChange={event => onChange({ ...form, saleAt: event.target.value })}
                        />
                    </label>
                    {form.advanceSeconds !== undefined ? (
                        <div role="note">
                            <p>原設定提前刷新 {form.advanceSeconds} 秒，目前尚未支援執行。可明確改為僅等待開賣。</p>
                            <button
                                type="button"
                                className="secondary"
                                disabled={disabled}
                                onClick={() =>
                                    onChange({
                                        mode: "scheduled",
                                        saleAt: form.saleAt,
                                        maxRunMinutes: form.maxRunMinutes,
                                    })
                                }
                            >
                                改為僅等待開賣
                            </button>
                        </div>
                    ) : (
                        <p>僅等待開賣，不刷新頁面。已過設定時間則立即繼續；登入與開賣等待不計入購票期限。</p>
                    )}
                </>
            )}
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
                    onChange={event => onChange({ ...form, maxRunMinutes: event.target.value })}
                />
            </label>
            <p>從開始選場次前計時，人工登入與開賣等待不計入。留空不設全程期限，各操作仍有自己的逾時限制。</p>
            <p>按「開始購票」時會先保存執行設定，再啟動購票瀏覽器。</p>
            {activityDirty && <p role="status">活動與順位有未儲存修改，請先到第一步儲存。</p>}
        </div>
    );
}
