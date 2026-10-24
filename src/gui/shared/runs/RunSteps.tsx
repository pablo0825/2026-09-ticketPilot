import { primaryButton } from "../styles.js";
import type { RunStep } from "./runStep.js";

interface Props {
    steps: RunStep[];
    participantsControl?: { onConfirm: () => void };
}

const icons: Partial<Record<RunStep["state"], string>> = {
    done: "✓",
    action: "!",
    failed: "✕",
    stopped: "■",
    unknown: "?",
};

const stateNames: Record<RunStep["state"], string> = {
    done: "已完成",
    running: "執行中",
    pending: "尚未開始",
    action: "輪到你",
    failed: "失敗",
    stopped: "已停止",
    unknown: "結果未確認",
    skipped: "未執行",
};

const stateStyles: Record<RunStep["state"], { icon: string; label: string; note: string }> = {
    done: { icon: "bg-emerald-700", label: "text-slate-800", note: "bg-slate-50 text-slate-800" },
    running: {
        icon: "border-2 border-slate-300 border-t-blue-700 motion-safe:animate-spin",
        label: "font-semibold",
        note: "bg-slate-50 text-slate-800",
    },
    pending: {
        icon: "border border-dashed border-slate-400",
        label: "text-slate-500",
        note: "bg-slate-50 text-slate-800",
    },
    action: { icon: "bg-amber-700", label: "font-semibold", note: "bg-amber-50 text-amber-800" },
    failed: { icon: "bg-red-700", label: "font-semibold", note: "bg-red-50 text-red-800" },
    stopped: { icon: "bg-slate-500", label: "text-slate-800", note: "bg-slate-50 text-slate-800" },
    unknown: { icon: "bg-yellow-700", label: "font-semibold", note: "bg-yellow-50 text-yellow-800" },
    skipped: { icon: "border border-slate-300", label: "text-slate-500", note: "bg-slate-50 text-slate-800" },
};

export function RunSteps({ steps, participantsControl }: Props) {
    return (
        <ol
            className="list-none divide-y divide-slate-100 rounded-lg border border-slate-200 px-4"
            role="list"
            aria-label="執行步驟"
        >
            {steps.map(step => (
                <li key={step.label} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 py-4">
                    <span
                        className={`mt-0.5 grid size-5 place-items-center rounded-full text-xs font-bold text-white ${stateStyles[step.state].icon}`}
                        role="img"
                        aria-label={stateNames[step.state]}
                    >
                        {icons[step.state] ?? ""}
                    </span>
                    <div>
                        <div className={`run-step-label ${stateStyles[step.state].label}`}>{step.label}</div>
                        {step.note && (
                            <div className={`mt-2 break-words rounded-lg p-3 text-sm ${stateStyles[step.state].note}`}>
                                {step.note}
                                {step.participantsButton && participantsControl && (
                                    <div>
                                        <button
                                            className={`${primaryButton} mt-3`}
                                            type="button"
                                            onClick={participantsControl.onConfirm}
                                        >
                                            參加者已填完
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </li>
            ))}
        </ol>
    );
}
