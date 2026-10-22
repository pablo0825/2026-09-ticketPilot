import type { TicketPlusActivitySettings } from "../../../config/ticketPlusActivity.js";
import { useEffect, useRef } from "react";
import type { ExecutionForm, ExecutionErrors } from "../platforms/ticketplus/formModel.js";
import { primaryButton, panel, fieldLabel, fieldInput } from "../shared/styles.js";

interface Props {
    settings?: TicketPlusActivitySettings;
    reason: string;
    hideReason: boolean;
    disabled: boolean;
    onStart: () => void;
    execution: ExecutionForm;
    executionErrors: ExecutionErrors;
    executionDisabled: boolean;
    onExecutionChange: (form: ExecutionForm) => void;
    confirmed: boolean;
    onConfirm: (confirmed: boolean) => void;
}

export function PurchaseConfirmPage({
    settings,
    reason,
    hideReason,
    disabled,
    onStart,
    execution: form,
    executionErrors: errors,
    executionDisabled,
    onExecutionChange,
    confirmed,
    onConfirm,
}: Props) {
    const saleInput = useRef<HTMLInputElement>(null);
    const minutesInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (errors.saleAt) saleInput.current?.focus();
        else if (errors.maxRunMinutes) minutesInput.current?.focus();
    }, [errors]);
    return (
        <section data-tailwind className={`${panel} space-y-6`} aria-label="活動摘要">
            <h2 className="text-xl font-semibold">活動摘要</h2>
            {settings && (
                <div id="summary" className="space-y-4 rounded-lg bg-slate-50 p-4">
                    <div className="summary-field flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
                        <span className="shrink-0 text-slate-500">活動名稱｜</span>
                        <span className="min-w-0 break-words">{settings.eventName}</span>
                    </div>
                    <div className="summary-field flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3">
                        <span className="shrink-0 text-slate-500">活動網址｜</span>
                        <a
                            className="min-w-0 break-all text-blue-700 underline focus-visible:outline-2 focus-visible:outline-blue-600"
                            href={settings.eventUrl}
                            title={settings.eventUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            {settings.eventUrl}
                        </a>
                    </div>
                    <h3 className="text-base font-semibold">購票順位</h3>
                    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="購票順位">
                        <table className="w-full border-collapse text-left text-sm [&_th]:whitespace-nowrap [&_th]:p-3 [&_th]:text-slate-500 [&_td]:p-3 [&_td]:align-top [&_td:not(:nth-child(4))]:whitespace-nowrap [&_tbody_tr]:border-t [&_tbody_tr]:border-slate-200">
                            <thead>
                                <tr>
                                    {["順位", "演出日期", "時間", "票種", "張數"].map(title => (
                                        <th key={title} scope="col">
                                            {title}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {settings.targets.map((target, index) => (
                                    <tr key={index}>
                                        <td>{index + 1}</td>
                                        <td>{target.date}</td>
                                        <td>{target.time}</td>
                                        <td className="min-w-32 max-w-sm break-words whitespace-normal">
                                            {target.ticketType}
                                        </td>
                                        <td>{target.quantity}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
            <div className="space-y-4">
                <h2 className="text-xl font-semibold">執行設定</h2>
                <label className={fieldLabel}>
                    執行方式
                    <select
                        className={`${fieldInput} h-11`}
                        value={form.mode}
                        disabled={executionDisabled}
                        onChange={event =>
                            onExecutionChange(
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
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3 [&>div]:md:col-span-2">
                        <div>
                            <label className={fieldLabel}>
                                開賣時間（台灣 UTC+8）
                                <input
                                    className={`${fieldInput} h-11`}
                                    ref={saleInput}
                                    aria-invalid={Boolean(errors.saleAt)}
                                    aria-describedby={errors.saleAt ? "ticketplus-sale-error" : undefined}
                                    type="datetime-local"
                                    step="1"
                                    disabled={executionDisabled}
                                    value={form.saleAt}
                                    onChange={event => onExecutionChange({ ...form, saleAt: event.target.value })}
                                />
                            </label>
                            {errors.saleAt && (
                                <p id="ticketplus-sale-error" className="mt-2 text-sm text-red-700" role="alert">
                                    {errors.saleAt}
                                </p>
                            )}
                        </div>
                        <label className={fieldLabel}>
                            提前刷新
                            <select
                                className={`${fieldInput} h-11`}
                                value={form.advanceSeconds ?? 1}
                                disabled={executionDisabled}
                                onChange={event => {
                                    const seconds = event.target.value;
                                    if (seconds === "1" || seconds === "2") {
                                        onExecutionChange({ ...form, advanceSeconds: seconds === "1" ? 1 : 2 });
                                    }
                                }}
                            >
                                <option value="1">1 秒</option>
                                <option value="2">2 秒</option>
                            </select>
                        </label>
                    </div>
                )}
                <label className={fieldLabel}>
                    最長執行時間（分鐘）
                    <input
                        className={`${fieldInput} h-11`}
                        ref={minutesInput}
                        aria-invalid={Boolean(errors.maxRunMinutes)}
                        aria-describedby={errors.maxRunMinutes ? "ticketplus-minutes-error" : undefined}
                        id="maxRunMinutes"
                        type="number"
                        min="10"
                        required
                        max="1440"
                        step="1"
                        disabled={executionDisabled}
                        value={form.maxRunMinutes}
                        onChange={event => onExecutionChange({ ...form, maxRunMinutes: event.target.value })}
                    />
                </label>
                {errors.maxRunMinutes && (
                    <p id="ticketplus-minutes-error" className="mt-2 text-sm text-red-700" role="alert">
                        {errors.maxRunMinutes}
                    </p>
                )}
            </div>
            <label className="flex items-start gap-3">
                <input
                    className="mt-1 size-4 shrink-0 accent-blue-600"
                    type="checkbox"
                    disabled={disabled}
                    checked={confirmed}
                    onChange={event => onConfirm(event.target.checked)}
                />
                {settings?.flowType === "lottery"
                    ? "我已確認活動、順位與張數，並了解程式會停在輸入資料頁等我填寫參加者，後續由我手動處理。"
                    : "我已確認活動、順位與張數，並了解程式會在資料頁勾選服務條款並按一次下一步，停在付款頁，付款由我手動處理。"}
            </label>
            {reason && !hideReason && <p role="status">{reason}</p>}
            <button
                className={primaryButton}
                type="button"
                disabled={disabled || Boolean(reason) || !confirmed}
                onClick={onStart}
            >
                開始購票
            </button>
        </section>
    );
}
