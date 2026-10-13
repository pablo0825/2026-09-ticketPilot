interface Props {
    disabled: boolean;
    status: string;
    canViewRun: boolean;
    onKlook: () => void;
    onViewRun: () => void;
}

export function PlatformHome({ disabled, status, canViewRun, onKlook, onViewRun }: Props) {
    return (
        <section id="platformHome" className="card">
            <h2>選擇購票平台</h2>
            <p>進入平台後，選擇活動並設定購票順位。</p>
            <table className="platform-table" aria-label="購票平台">
                <thead>
                    <tr>
                        <th scope="col">購票平台</th>
                        <th scope="col">目前狀態</th>
                        <th scope="col">操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <th scope="row">Klook</th>
                        <td id="platformStatus" aria-live="polite">
                            {status}
                        </td>
                        <td>
                            <div className="platform-actions">
                                <button id="selectKlook" disabled={disabled} onClick={onKlook}>
                                    進入平台
                                </button>
                                {canViewRun && (
                                    <button
                                        id="platformViewRun"
                                        className="secondary"
                                        disabled={disabled}
                                        onClick={onViewRun}
                                    >
                                        查看狀態
                                    </button>
                                )}
                            </div>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">TicketPlus</th>
                        <td>尚未支援</td>
                        <td>—</td>
                    </tr>
                </tbody>
            </table>
        </section>
    );
}
