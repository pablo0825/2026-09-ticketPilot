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
            <h2>執行設定</h2>
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
                    <p>
                        提前 {form.advanceSeconds ?? 1} 秒刷新活動頁；開賣後目標場次仍尚未開賣時，間隔至少 3
                        秒再次刷新，最多等待至開賣後 2 分鐘。
                    </p>
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
            {activityDirty && <p role="status">活動與順位有未儲存修改，請先到第一步儲存。</p>}
        </div>
    );
}
