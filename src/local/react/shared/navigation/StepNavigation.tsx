interface Props<Step extends string> {
    steps: readonly { id: Step; label: string }[];
    currentStep: Step;
    disabled: boolean;
    onChange: (step: Step) => void;
}

export function StepNavigation<Step extends string>({ steps, currentStep, disabled, onChange }: Props<Step>) {
    return (
        <nav
            data-tailwind
            className="step-tabs mb-4 flex flex-wrap gap-2 border-b border-slate-200 pb-3"
            aria-label="設定步驟"
        >
            {steps.map(item => (
                <button
                    type="button"
                    key={item.id}
                    aria-current={currentStep === item.id ? "step" : undefined}
                    disabled={disabled}
                    onClick={() => onChange(item.id)}
                    className="rounded-lg bg-transparent px-4 py-3 text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50 aria-[current=step]:bg-blue-50 aria-[current=step]:text-blue-700"
                >
                    {item.label}
                </button>
            ))}
        </nav>
    );
}
