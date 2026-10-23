import { primaryButton, secondaryButton, panelHeading } from "../shared/styles.js";

export interface PlatformHomeEntry {
    id: string;
    name: string;
    status: string;
    statusId?: string;
    announceStatus?: boolean;
    enterButtonId?: string;
    onEnter: () => void;
    onViewRun?: () => void;
    viewRunButtonId?: string;
}

interface Props {
    disabled: boolean;
    platforms: PlatformHomeEntry[];
    runNotice?: { message: string; onViewRun: () => void; buttonId?: string };
}

export function PlatformHome({ disabled, platforms, runNotice }: Props) {
    return (
        <div data-tailwind className="rounded-xl border border-slate-200 bg-white">
            <div className={panelHeading}>
                <h2 className="pl-1 text-lg font-semibold text-blue-900 sm:pl-3">購票平台</h2>
            </div>
            <section id="platformHome" className="p-4 sm:p-6">
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
                        {platforms.map(platform => (
                            <tr key={platform.id}>
                                <th scope="row">{platform.name}</th>
                                <td id={platform.statusId} aria-live={platform.announceStatus ? "polite" : undefined}>
                                    {platform.status}
                                </td>
                                <td>
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            className={primaryButton}
                                            id={platform.enterButtonId}
                                            disabled={disabled}
                                            onClick={platform.onEnter}
                                        >
                                            進入平台
                                        </button>
                                        {platform.onViewRun && (
                                            <button
                                                id={platform.viewRunButtonId}
                                                className={secondaryButton}
                                                disabled={disabled}
                                                onClick={platform.onViewRun}
                                            >
                                                查看狀態
                                            </button>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {runNotice && (
                    <div className="mt-4 space-y-3">
                        <p>{runNotice.message}</p>
                        <button
                            id={runNotice.buttonId}
                            className={secondaryButton}
                            disabled={disabled}
                            onClick={runNotice.onViewRun}
                        >
                            查看狀態
                        </button>
                    </div>
                )}
            </section>
        </div>
    );
}
