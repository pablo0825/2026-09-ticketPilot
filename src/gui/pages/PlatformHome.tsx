import { primaryButton, secondaryButton, panelHeading } from "../shared/styles.js";

export interface PlatformHomeEntry {
    id: string;
    name: string;
    status: string;
    onEnter: () => void;
    onViewRun?: () => void;
}

interface Props {
    platforms: readonly PlatformHomeEntry[];
    disabled: boolean;
    entryBlocked: boolean;
    unknownRun?: { status: string; onView: () => void };
}

export function PlatformHome({ platforms, disabled, entryBlocked, unknownRun }: Props) {
    return (
        <section data-tailwind className="rounded-xl border border-slate-200 bg-white">
            <div className={panelHeading}>
                <h2 className="pl-1 text-lg font-semibold text-blue-900 sm:pl-3">購票平台</h2>
            </div>
            <div className="p-4 sm:p-6">
                <table
                    aria-label="購票平台"
                    className="w-full table-fixed border-collapse text-left text-sm sm:text-base [&_th]:px-1 [&_th]:py-3 [&_td]:px-1 [&_td]:py-4 sm:[&_th]:px-3 sm:[&_td]:px-3 [&_tbody_tr]:border-t [&_tbody_tr]:border-slate-200"
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
                        {platforms.map(platform => (
                            <tr key={platform.id}>
                                <th scope="row" className="break-words">
                                    {platform.name}
                                </th>
                                <td aria-live="polite">{platform.status}</td>
                                <td>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className={primaryButton}
                                            aria-label={`進入 ${platform.name}`}
                                            disabled={disabled || entryBlocked}
                                            onClick={platform.onEnter}
                                        >
                                            進入平台
                                        </button>
                                        {platform.onViewRun && (
                                            <button
                                                type="button"
                                                className={secondaryButton}
                                                disabled={disabled}
                                                onClick={platform.onViewRun}
                                            >
                                                查看目前狀態
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {unknownRun && (
                    <div className="mt-4 space-y-3">
                        <p>平台未知的執行紀錄：{unknownRun.status}</p>
                        <button
                            type="button"
                            className={secondaryButton}
                            disabled={disabled}
                            onClick={unknownRun.onView}
                        >
                            查看目前狀態
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
}
