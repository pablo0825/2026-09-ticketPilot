import type { RunStep } from "./ticketPlusSteps.js";

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

export function RunSteps({ steps, participantsControl }: Props) {
    return (
        <ol className="run-steps" aria-label="執行步驟">
            {steps.map(step => (
                <li key={step.label} className={`run-step ${step.state}`}>
                    <span className="run-step-icon" role="img" aria-label={stateNames[step.state]}>
                        {icons[step.state] ?? ""}
                    </span>
                    <div>
                        <div className="run-step-label">{step.label}</div>
                        {step.note && (
                            <div className="run-step-note">
                                {step.note}
                                {step.participantsButton && participantsControl && (
                                    <div>
                                        <button type="button" onClick={participantsControl.onConfirm}>
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
