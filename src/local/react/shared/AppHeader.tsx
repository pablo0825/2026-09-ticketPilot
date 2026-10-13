interface Props {
    disabled: boolean;
    onHome: () => void;
}

export function AppHeader({ disabled, onHome }: Props) {
    return (
        <header>
            <div>
                <small>本機購票助手</small>
                <h1>
                    <button
                        id="brandHome"
                        className="brand-home"
                        aria-label="TicketPilot，返回平台首頁"
                        title="返回平台首頁"
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
