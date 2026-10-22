import { primaryButton, secondaryButton, panel } from "../shared/styles.js";
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
        <div data-tailwind className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">購票平台</h2>
            </div>
            <section id="platformHome" className={panel}>
                <table
                    className="w-full table-fixed border-collapse text-left text-sm sm:text-base [&_th]:px-1 [&_th]:py-3 [&_td]:px-1 [&_td]:py-4 sm:[&_th]:px-3 sm:[&_td]:px-3 [&_tbody_tr]:border-t [&_tbody_tr]:border-slate-200"
                    aria-label="購票平台"
                >
                    <thead className="text-sm text-slate-500">
                        <tr>
                            <th scope="col" className="w-1/4">
                                平台名稱
                            </th>
                            <th scope="col">目前狀態</th>
                            <th scope="col" className="w-2/5">
                                操作
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <th scope="row">Klook</th>
                            <td id="platformStatus" aria-live="polite">
                                {canViewRun && runPlatform !== "klook" ? "可進入設定" : status}
                            </td>
                            <td>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        className={primaryButton}
                                        id="selectKlook"
                                        disabled={disabled}
                                        onClick={onKlook}
                                    >
                                        進入平台
                                    </button>
                                    {canViewRun && runPlatform === "klook" && (
                                        <button
                                            id="platformViewRun"
                                            className={secondaryButton}
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
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        className={primaryButton}
                                        id="selectTicketPlus"
                                        disabled={disabled}
                                        onClick={onTicketPlus}
                                    >
                                        進入平台
                                    </button>
                                    {canViewRun && runPlatform === "ticketplus" && (
                                        <button
                                            id="platformViewRun"
                                            className={secondaryButton}
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
                    <div className="mt-4 space-y-3">
                        <p>平台未知的購票程序：{status}</p>
                        <button
                            id="platformViewRun"
                            className={secondaryButton}
                            disabled={disabled}
                            onClick={onViewRun}
                        >
                            查看狀態
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
