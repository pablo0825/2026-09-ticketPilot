import { useEffect, useRef } from "react";
import type { ExecutionForm, ExecutionErrors } from "../platforms/ticketplus/formModel.js";
import type { ActivityForm as KlookActivityForm } from "../platforms/klook/formModel.js";
import { primaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import type { PurchaseSummaryData } from "./purchaseSummary.js";

interface CommonProps {
    summary?: PurchaseSummaryData;
    confirmation: string;
    reason: string;
    disabled: boolean;
    startDisabled?: boolean;
    attached?: boolean;
    onStart: () => void;
    executionDisabled: boolean;
    confirmed: boolean;
    onConfirm: (confirmed: boolean) => void;
}

interface TicketPlusProps extends CommonProps {
    platform?: "ticketplus";
    execution: ExecutionForm;
    executionErrors: ExecutionErrors;
    onExecutionChange: (form: ExecutionForm) => void;
}

export type KlookExecutionForm = Pick<KlookActivityForm, "mode" | "saleAt" | "advance">;
interface KlookProps extends CommonProps {
    platform: "klook";
    execution: KlookExecutionForm;
    onExecutionChange: (form: KlookExecutionForm) => void;
}

type Props = TicketPlusProps | KlookProps;

export function PurchaseConfirmPage(props: Props) {
    const { reason, disabled, onStart, execution: form, executionDisabled, confirmed, onConfirm } = props;
    const isKlook = props.platform === "klook";
    const attached = props.attached ?? !isKlook;
    const summary = props.summary;
    const errors = props.platform === "klook" ? undefined : props.executionErrors;
    const saleInput = useRef<HTMLInputElement>(null);
    const minutesInput = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (errors?.saleAt) saleInput.current?.focus();
        else if (errors?.maxRunMinutes) minutesInput.current?.focus();
    }, [errors]);

    // 兩平台保留各自的時間草稿語意；Klook 切回立即開始不清除尚未儲存的時間。
    function changeMode(mode: "now" | "scheduled") {
        if (props.platform === "klook") {
            props.onExecutionChange({ ...props.execution, mode });
        } else {
            props.onExecutionChange(
                mode === "now"
                    ? { mode, saleAt: "", maxRunMinutes: props.execution.maxRunMinutes }
                    : { ...props.execution, mode },
            );
        }
    }

    function changeSaleAt(saleAt: string) {
        if (props.platform === "klook") props.onExecutionChange({ ...props.execution, saleAt });
        else props.onExecutionChange({ ...props.execution, saleAt });
    }

    function changeAdvance(seconds: string) {
        if (seconds !== "1" && seconds !== "2") return;
        if (props.platform === "klook") props.onExecutionChange({ ...props.execution, advance: seconds });
        else props.onExecutionChange({ ...props.execution, advanceSeconds: seconds === "1" ? 1 : 2 });
    }

    return (
        <section
            data-tailwind
            id={isKlook ? "purchaseSummary" : undefined}
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
            ) : isKlook ? (
                <p id="summary">請先儲存活動設定。</p>
            ) : null}
            <div className="space-y-4">
                <h2 className="text-xl font-semibold">執行設定</h2>
                <label className={fieldLabel}>
                    執行方式
                    <select
                        id={isKlook ? "mode" : undefined}
                        className={`${fieldInput} h-11`}
                        value={form.mode}
                        disabled={executionDisabled}
                        onChange={event => {
                            const mode = event.target.value;
                            if (mode === "now" || mode === "scheduled") changeMode(mode);
                        }}
                    >
                        <option value="now">立即開始</option>
                        <option value="scheduled">指定開賣時間</option>
                    </select>
                </label>
                {form.mode === "scheduled" && (
                    <div
                        id={isKlook ? "schedule" : undefined}
                        className="grid grid-cols-1 gap-4 md:grid-cols-3 [&>div]:md:col-span-2"
                    >
                        <div>
                            <label className={fieldLabel}>
                                開賣時間（台灣 UTC+8）
                                <input
                                    id={isKlook ? "saleAt" : undefined}
                                    className={`${fieldInput} h-11`}
                                    ref={saleInput}
                                    aria-invalid={Boolean(errors?.saleAt)}
                                    aria-describedby={errors?.saleAt ? "ticketplus-sale-error" : undefined}
                                    type="datetime-local"
                                    step="1"
                                    disabled={executionDisabled}
                                    value={form.saleAt}
                                    onChange={event => changeSaleAt(event.target.value)}
                                />
                            </label>
                            {errors?.saleAt && (
                                <p id="ticketplus-sale-error" className="mt-2 text-sm text-red-700" role="alert">
                                    {errors.saleAt}
                                </p>
                            )}
                        </div>
                        <label className={fieldLabel}>
                            提前刷新
                            <select
                                id={isKlook ? "advance" : undefined}
                                className={`${fieldInput} h-11`}
                                value={
                                    props.platform === "klook"
                                        ? props.execution.advance
                                        : (props.execution.advanceSeconds ?? 1)
                                }
                                disabled={executionDisabled}
                                onChange={event => changeAdvance(event.target.value)}
                            >
                                <option value="1">1 秒</option>
                                <option value="2">2 秒</option>
                            </select>
                        </label>
                    </div>
                )}
                {props.platform !== "klook" && (
                    <>
                        <label className={fieldLabel}>
                            最長執行時間（分鐘）
                            <input
                                className={`${fieldInput} h-11`}
                                ref={minutesInput}
                                aria-invalid={Boolean(errors?.maxRunMinutes)}
                                aria-describedby={errors?.maxRunMinutes ? "ticketplus-minutes-error" : undefined}
                                id="maxRunMinutes"
                                type="number"
                                min="10"
                                required
                                max="1440"
                                step="1"
                                disabled={executionDisabled}
                                value={props.execution.maxRunMinutes}
                                onChange={event =>
                                    props.onExecutionChange({ ...props.execution, maxRunMinutes: event.target.value })
                                }
                            />
                        </label>
                        {errors?.maxRunMinutes && (
                            <p id="ticketplus-minutes-error" className="mt-2 text-sm text-red-700" role="alert">
                                {errors.maxRunMinutes}
                            </p>
                        )}
                    </>
                )}
            </div>
            <label className="flex items-start gap-3">
                <input
                    id={isKlook ? "confirm" : undefined}
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
                id={isKlook ? "start" : undefined}
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
