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
            className="step-tabs flex gap-1 overflow-x-auto rounded-t-xl border border-slate-200 bg-white px-3"
            aria-label="設定步驟"
        >
            {steps.map(item => (
                <button
                    type="button"
                    key={item.id}
                    aria-current={currentStep === item.id ? "step" : undefined}
                    disabled={disabled}
                    onClick={() => onChange(item.id)}
                    className="shrink-0 whitespace-nowrap border-b-4 border-transparent bg-transparent px-4 py-4 text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-blue-600 disabled:opacity-50 aria-[current=step]:border-blue-900 aria-[current=step]:font-bold aria-[current=step]:text-blue-900"
                >
                    {item.label}
                </button>
            ))}
        </nav>
    );
}
