import type { ExecutionForm } from "./formModel.js";

interface Props {
    form: ExecutionForm;
    disabled: boolean;
    onChange: (form: ExecutionForm) => void;
}

export function ExecutionEditor({ form, disabled, onChange }: Props) {
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
                <div className="ticketplus-sale-fields">
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
                    <label>
                        提前刷新
                        <select
                            value={form.advanceSeconds ?? 1}
                            disabled={disabled}
                            onChange={event => {
                                const seconds = event.target.value;
                                if (seconds === "1" || seconds === "2") {
                                    onChange({ ...form, advanceSeconds: seconds === "1" ? 1 : 2 });
                                }
                            }}
                        >
                            <option value="1">1 秒</option>
                            <option value="2">2 秒</option>
                        </select>
                    </label>
                </div>
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
        </div>
    );
}
