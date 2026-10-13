interface Props {
    disabled: boolean;
    hasActiveRun: boolean;
    hasPurchaseResult: boolean;
    hasSimulationResult: boolean;
    onViewResult: (kind: "purchase" | "simulation") => void;
    onKlook: () => void;
    onViewRun: () => void;
}

export function PlatformHome({
    disabled,
    hasActiveRun,
    onKlook,
    onViewRun,
    hasPurchaseResult,
    hasSimulationResult,
    onViewResult,
}: Props) {
    return (
        <section id="platformHome" className="card">
            <h2>選擇購票平台</h2>
            <p>進入平台後，選擇活動並設定購票順位。</p>
            <div className="platform-options">
                <div className="platform-option">
                    <h3>Klook</h3>
                    <p>管理 Klook 活動與購票設定。</p>
                    <button id="selectKlook" disabled={disabled} onClick={onKlook}>
                        進入 Klook
                    </button>
                </div>
                <div className="platform-option">
                    <h3>TicketPlus</h3>
                    <p>尚未支援</p>
                    <button disabled>TicketPlus 尚未支援</button>
                </div>
            </div>
            {hasActiveRun && (
                <div>
                    <p>目前仍有購票瀏覽器占用或流程執行中；切換頁面不會停止流程或解除占用。</p>
                    <button id="platformViewRun" className="secondary" disabled={disabled} onClick={onViewRun}>
                        查看目前狀態
                    </button>
                </div>
            )}
            {!hasActiveRun && (hasPurchaseResult || hasSimulationResult) && (
                <div>
                    <p>最近的執行結果仍可查看；查看不會重新開始。</p>
                    {hasPurchaseResult && (
                        <button
                            id="platformPurchaseResult"
                            className="secondary"
                            disabled={disabled}
                            onClick={() => onViewResult("purchase")}
                        >
                            查看最近購票結果
                        </button>
                    )}
                    {hasSimulationResult && (
                        <button
                            id="platformSimulationResult"
                            className="secondary"
                            disabled={disabled}
                            onClick={() => onViewResult("simulation")}
                        >
                            查看最近模擬結果
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
