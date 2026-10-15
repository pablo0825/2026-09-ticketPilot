import type { PurchaseSnapshot } from "../../purchaseRuns.js";

interface Props {
    disabled: boolean;
    status: string;
    canViewRun: boolean;
    runPlatform: PurchaseSnapshot["platform"];
    onKlook: () => void;
    onTicketPlus: () => void;
    onViewRun: () => void;
}

export function PlatformHome({ disabled, status, canViewRun, runPlatform, onKlook, onTicketPlus, onViewRun }: Props) {
    return (
        <section id="platformHome" className="card">
            <h2>購票平台</h2>
            <table className="platform-table" aria-label="購票平台">
                <thead>
                    <tr>
                        <th scope="col">平台名稱</th>
                        <th scope="col">目前狀態</th>
                        <th scope="col">操作</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <th scope="row">Klook</th>
                        <td id="platformStatus" aria-live="polite">
                            {canViewRun && runPlatform !== "klook" ? "可進入設定" : status}
                        </td>
                        <td>
                            <div className="platform-actions">
                                <button id="selectKlook" disabled={disabled} onClick={onKlook}>
                                    進入平台
                                </button>
                                {canViewRun && runPlatform === "klook" && (
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
                        <td>{canViewRun && runPlatform === "ticketplus" ? status : "可進入設定"}</td>
                        <td>
                            <div className="platform-actions">
                                <button id="selectTicketPlus" disabled={disabled} onClick={onTicketPlus}>
                                    進入平台
                                </button>
                                {canViewRun && runPlatform === "ticketplus" && (
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
                </tbody>
            </table>
            {canViewRun && runPlatform === null && (
                <div>
                    <p>平台未知的購票程序：{status}</p>
                    <button id="platformViewRun" className="secondary" disabled={disabled} onClick={onViewRun}>
                        查看狀態
                    </button>
                </div>
            )}
        </section>
    );
}
