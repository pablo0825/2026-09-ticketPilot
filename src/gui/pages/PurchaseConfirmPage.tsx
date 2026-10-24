import { useEffect, useRef } from "react";
import { primaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import type { PurchaseSummaryData } from "./purchaseSummaryDefinition.js";

interface Props {
    summary?: PurchaseSummaryData;
    emptySummaryMessage?: string;
    confirmation: string;
    reason: string;
    disabled: boolean;
    startDisabled?: boolean;
    attached?: boolean;
    onStart: () => void;
    executionDisabled: boolean;
    confirmed: boolean;
    onConfirm: (confirmed: boolean) => void;
    execution: Readonly<{
        mode: "now" | "scheduled";
        saleAt: string;
        advanceSeconds: string | number;
    }>;
    executionErrors?: { saleAt?: string; maxRunMinutes?: string };
    onModeChange: (mode: "now" | "scheduled") => void;
    onSaleAtChange: (saleAt: string) => void;
    onAdvanceChange: (seconds: 1 | 2) => void;
    maxRunMinutes?: {
        value: string;
        min: number;
        max: number;
        onChange: (value: string) => void;
    };
    ids?: {
        panel?: string;
        mode?: string;
        schedule?: string;
        saleAt?: string;
        saleAtError?: string;
        advance?: string;
        maxRunMinutes?: string;
        maxRunMinutesError?: string;
        confirm?: string;
        start?: string;
    };
}

export function PurchaseConfirmPage(props: Props) {
    const { reason, disabled, onStart, execution: form, executionDisabled, confirmed, onConfirm } = props;
    const attached = props.attached ?? true;
    const summary = props.summary;
    const errors = props.executionErrors;
    const ids = props.ids;
    const saleInput = useRef<HTMLInputElement>(null);
    const minutesInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (errors?.saleAt) saleInput.current?.focus();
        else if (errors?.maxRunMinutes) minutesInput.current?.focus();
    }, [errors]);

    return (
        <section
            data-tailwind
            id={ids?.panel}
            className={`${attached ? stepPanel : panel} space-y-6`}
            aria-label="活動摘要"
        >
            <h2 className="text-xl font-semibold">活動摘要</h2>
            {summary ? (
                <div id="summary" className="space-y-4 rounded-lg bg-slate-50 p-4">
                    {summary.fields.map(field => (
                        <div
                            key={field.label}
                            className="summary-field flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3"
                        >
                            <span className="summary-label shrink-0 text-slate-500">{field.label}｜</span>
                            {field.href ? (
                                <a
                                    className="min-w-0 break-all text-blue-700 underline focus-visible:outline-2 focus-visible:outline-blue-600"
                                    href={field.href}
                                    title={field.value}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    {field.value}
                                </a>
                            ) : (
                                <span className="min-w-0 break-words">{field.value}</span>
                            )}
                        </div>
                    ))}
                    <h3 className="text-base font-semibold">購票順位</h3>
                    <div
                        className="summary-table-scroll overflow-x-auto"
                        tabIndex={0}
                        role="region"
                        aria-label="購票順位"
                    >
                        <table className="w-full border-collapse text-left text-sm [&_th]:whitespace-nowrap [&_th]:p-3 [&_th]:text-slate-500 [&_td]:p-3 [&_td]:align-top [&_tbody_tr]:border-t [&_tbody_tr]:border-slate-200">
                            <thead>
                                <tr>
                                    {summary.columns.map(column => (
                                        <th key={column.label} scope="col">
                                            {column.label}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {summary.rows.map((row, index) => (
                                    <tr key={index}>
                                        {row.map((value, column) => (
                                            <td
                                                key={column}
                                                className={
                                                    summary.columns[column]?.wrap
                                                        ? "min-w-32 max-w-sm break-words whitespace-normal"
                                                        : "whitespace-nowrap"
                                                }
                                            >
                                                {value}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {summary.notes.map(field => (
                        <div
                            key={field.label}
                            className="summary-field flex min-w-0 flex-col gap-1 sm:flex-row sm:gap-3"
                        >
                            <span className="summary-label shrink-0 text-slate-500">{field.label}｜</span>
                            <span className="min-w-0 break-words">{field.value}</span>
                        </div>
                    ))}
                </div>
            ) : props.emptySummaryMessage ? (
                <p id="summary">{props.emptySummaryMessage}</p>
            ) : null}
            <div className="space-y-4">
                <h2 className="text-xl font-semibold">執行設定</h2>
                <label className={fieldLabel}>
                    執行方式
                    <select
                        id={ids?.mode}
                        className={`${fieldInput} h-11`}
                        value={form.mode}
                        disabled={executionDisabled}
                        onChange={event => {
                            const mode = event.target.value;
                            if (mode === "now" || mode === "scheduled") props.onModeChange(mode);
                        }}
                    >
                        <option value="now">立即開始</option>
                        <option value="scheduled">指定開賣時間</option>
                    </select>
                </label>
                {form.mode === "scheduled" && (
                    <div id={ids?.schedule} className="grid grid-cols-1 gap-4 md:grid-cols-3 [&>div]:md:col-span-2">
                        <div>
                            <label className={fieldLabel}>
                                開賣時間（台灣 UTC+8）
                                <input
                                    id={ids?.saleAt}
                                    className={`${fieldInput} h-11`}
                                    ref={saleInput}
                                    aria-invalid={Boolean(errors?.saleAt)}
                                    aria-describedby={errors?.saleAt ? ids?.saleAtError : undefined}
                                    type="datetime-local"
                                    step="1"
                                    disabled={executionDisabled}
                                    value={form.saleAt}
                                    onChange={event => props.onSaleAtChange(event.target.value)}
                                />
                            </label>
                            {errors?.saleAt && (
                                <p id={ids?.saleAtError} className="mt-2 text-sm text-red-700" role="alert">
                                    {errors.saleAt}
                                </p>
                            )}
                        </div>
                        <label className={fieldLabel}>
                            提前刷新
                            <select
                                id={ids?.advance}
                                className={`${fieldInput} h-11`}
                                value={form.advanceSeconds}
                                disabled={executionDisabled}
                                onChange={event => {
                                    const seconds = event.target.value;
                                    if (seconds === "1" || seconds === "2") {
                                        props.onAdvanceChange(seconds === "1" ? 1 : 2);
                                    }
                                }}
                            >
                                <option value="1">1 秒</option>
                                <option value="2">2 秒</option>
                            </select>
                        </label>
                    </div>
                )}
                {props.maxRunMinutes && (
                    <>
                        <label className={fieldLabel}>
                            最長執行時間（分鐘）
                            <input
                                className={`${fieldInput} h-11`}
                                ref={minutesInput}
                                aria-invalid={Boolean(errors?.maxRunMinutes)}
                                aria-describedby={errors?.maxRunMinutes ? ids?.maxRunMinutesError : undefined}
                                id={ids?.maxRunMinutes}
                                type="number"
                                min={props.maxRunMinutes.min}
                                required
                                max={props.maxRunMinutes.max}
                                step="1"
                                disabled={executionDisabled}
                                value={props.maxRunMinutes.value}
                                onChange={event => props.maxRunMinutes?.onChange(event.target.value)}
                            />
                        </label>
                        {errors?.maxRunMinutes && (
                            <p id={ids?.maxRunMinutesError} className="mt-2 text-sm text-red-700" role="alert">
                                {errors.maxRunMinutes}
                            </p>
                        )}
                    </>
                )}
            </div>
            <label className="flex items-start gap-3">
                <input
                    id={ids?.confirm}
                    className="mt-1 size-4 shrink-0 accent-blue-600"
                    type="checkbox"
                    disabled={disabled}
                    checked={confirmed}
                    onChange={event => onConfirm(event.target.checked)}
                />
                {props.confirmation}
            </label>
            {reason && <p role="status">{reason}</p>}
            <button
                id={ids?.start}
                className={primaryButton}
                type="button"
                disabled={disabled || props.startDisabled || Boolean(reason) || !confirmed}
                onClick={onStart}
            >
                開始購票
            </button>
        </section>
    );
}
