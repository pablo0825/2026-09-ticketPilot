import type { ScheduleForm } from "./formModel.js";

interface Props {
    form: ScheduleForm;
    disabled: boolean;
    saveDisabled: boolean;
    activityDirty: boolean;
    onChange: (form: ScheduleForm) => void;
    onSave: () => void;
}

export function ScheduleEditor({ form, disabled, saveDisabled, activityDirty, onChange, onSave }: Props) {
    return (
        <div>
            <h3>開始時間</h3>
            <label>
                執行方式
                <select
                    value={form.mode}
                    disabled={disabled}
                    onChange={event =>
                        onChange(
                            event.target.value === "now" ? { mode: "now", saleAt: "" } : { ...form, mode: "scheduled" },
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
                                onClick={() => onChange({ mode: "scheduled", saleAt: form.saleAt })}
                            >
                                改為僅等待開賣
                            </button>
                        </div>
                    ) : (
                        <p>僅等待開賣，不刷新頁面。已過設定時間則立即繼續；登入與開賣等待不計入購票期限。</p>
                    )}
                </>
            )}
            {activityDirty && <p role="status">活動與順位有未儲存修改，請先到第一步儲存，再儲存開始設定。</p>}
            <button type="button" className="secondary" disabled={disabled || saveDisabled} onClick={onSave}>
                儲存開始設定
            </button>
        </div>
    );
}
