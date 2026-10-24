interface Props {
    disabled: boolean;
    onHome: () => void;
}

export function AppHeader({ disabled, onHome }: Props) {
    return (
        <header data-tailwind className="mb-8">
            <div>
                <small className="text-sm text-slate-500">本機購票助手</small>
                <h1 className="mt-1 text-3xl font-bold tracking-tight">
                    <button
                        id="brandHome"
                        className="rounded bg-transparent p-0 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600 disabled:opacity-50"
                        aria-label="TicketPilot，返回活動列表"
                        title="返回活動列表"
                        disabled={disabled}
                        onClick={onHome}
                    >
                        TicketPilot
                    </button>
                </h1>
            </div>
        </header>
    );
}
