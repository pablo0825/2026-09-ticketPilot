import { useEffect, useRef } from "react";
import type { ExecutionForm, ExecutionErrors } from "./formModel.js";

interface Props {
    form: ExecutionForm;
    errors: ExecutionErrors;
    disabled: boolean;
    onChange: (form: ExecutionForm) => void;
}

export function ExecutionEditor({ form, errors, disabled, onChange }: Props) {
    const saleInput = useRef<HTMLInputElement>(null);
    const minutesInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (errors.saleAt) saleInput.current?.focus();
        else if (errors.maxRunMinutes) minutesInput.current?.focus();
    }, [errors]);
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
                    <div>
                        <label>
                            開賣時間（台灣 UTC+8）
                            <input
                                ref={saleInput}
                                aria-invalid={Boolean(errors.saleAt)}
                                aria-describedby={errors.saleAt ? "ticketplus-sale-error" : undefined}
                                type="datetime-local"
                                step="1"
                                disabled={disabled}
                                value={form.saleAt}
                                onChange={event => onChange({ ...form, saleAt: event.target.value })}
                            />
                        </label>
                        {errors.saleAt && (
                            <p id="ticketplus-sale-error" role="alert">
                                {errors.saleAt}
                            </p>
                        )}
                    </div>
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
                最長執行時間（分鐘）
                <input
                    ref={minutesInput}
                    aria-invalid={Boolean(errors.maxRunMinutes)}
                    aria-describedby={errors.maxRunMinutes ? "ticketplus-minutes-error" : undefined}
                    id="maxRunMinutes"
                    type="number"
                    min="10"
                    required
                    max="1440"
                    step="1"
                    disabled={disabled}
                    value={form.maxRunMinutes}
                    onChange={event => onChange({ ...form, maxRunMinutes: event.target.value })}
                />
            </label>
            {errors.maxRunMinutes && (
                <p id="ticketplus-minutes-error" role="alert">
                    {errors.maxRunMinutes}
                </p>
            )}
        </div>
    );
}
