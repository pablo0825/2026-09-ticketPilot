import type { ActivityExecutionStatus } from "../../shared/activityExecutionStatus.js";
import { primaryButton, secondaryButton, panelHeading, badgeColors } from "../shared/styles.js";

export interface ActivityListEntry {
    id: string;
    eventName: string;
    executionStatus: ActivityExecutionStatus | "待重新載入";
}
interface Props {
    activities: ActivityListEntry[];
    disabled: boolean;
    mutationsDisabled: boolean;
    onNew: () => void;
    onLoad: (id: string) => void;
    onRemove: (id: string) => void;
    currentRun?: { message: string; disabled: boolean; onView: () => void };
    // 正在使用購票瀏覽器的活動；這一列顯示即時狀態與查看狀態按鈕。
    running?: {
        id: string;
        badge: { text: string; tone: keyof typeof badgeColors };
        viewDisabled: boolean;
        onView: () => void;
    };
}

export function ActivityListPage({
    activities,
    disabled,
    mutationsDisabled,
    onNew,
    onLoad,
    onRemove,
    running,
    currentRun,
}: Props) {
    return (
        <div data-tailwind className="rounded-xl border border-slate-200 bg-white">
            <div className={panelHeading}>
                <h2 className="pl-3 text-lg font-semibold text-blue-900">活動列表</h2>
                <button
                    id="new"
                    className={`${primaryButton} group relative inline-flex size-10 shrink-0 items-center justify-center p-0! text-xl leading-none`}
                    aria-label="新增活動"
                    disabled={disabled || mutationsDisabled}
                    onClick={onNew}
                >
                    <span aria-hidden="true">＋</span>
                    <span
                        className="icon-button-tip absolute right-0 top-full z-10 mt-2 hidden whitespace-nowrap rounded bg-slate-800 px-3 py-2 text-sm text-white group-hover:block group-focus-visible:block"
                        aria-hidden="true"
                    >
                        新增活動
                    </span>
                </button>
            </div>
            <div className="space-y-4 p-4 sm:p-6">
                {currentRun && (
                    <div className="space-y-3" hidden={!currentRun.message}>
                        <p id="homeRun" hidden={!currentRun.message}>
                            {currentRun.message}
                        </p>
                        <button
                            id="viewRun"
                            className={secondaryButton}
                            hidden={!currentRun.message}
                            disabled={currentRun.disabled}
                            onClick={currentRun.onView}
                        >
                            查看目前狀態
                        </button>
                    </div>
                )}
                <p id="emptyActivities" hidden={activities.length > 0}>
                    尚未儲存活動，請新增活動。
                </p>
                <div className="overflow-x-auto">
                    <table className="w-full min-w-xl border-collapse text-left [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-4 [&_td]:align-top">
                        <thead className="border-b border-slate-200 text-sm text-slate-500">
                            <tr>
                                {["活動名稱", "執行狀態", "操作"].map(label => (
                                    <th key={label} scope="col">
                                        {label}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody id="activities">
                            {activities.map(item => {
                                const runningItem = running?.id === item.id ? running : undefined;
                                return (
                                    <tr
                                        key={item.id}
                                        data-activity-id={item.id}
                                        className={`border-b border-slate-200 last:border-0 ${runningItem ? "bg-blue-50" : ""}`}
                                    >
                                        <td className="min-w-40 max-w-sm break-words font-medium">{item.eventName}</td>
                                        {runningItem ? (
                                            <td>
                                                <span
                                                    className={`status-badge inline-block rounded-full px-2 py-1 text-xs font-semibold ${badgeColors[runningItem.badge.tone]}`}
                                                >
                                                    {runningItem.badge.text}
                                                </span>
                                            </td>
                                        ) : (
                                            <td
                                                className="activity-status"
                                                title={
                                                    item.executionStatus === "已執行"
                                                        ? "已執行不代表購票或付款成功。"
                                                        : undefined
                                                }
                                            >
                                                {item.executionStatus || "尚無執行紀錄"}
                                            </td>
                                        )}
                                        <td>
                                            <div className="flex flex-wrap gap-2">
                                                {runningItem ? (
                                                    <button
                                                        className={primaryButton}
                                                        disabled={runningItem.viewDisabled}
                                                        onClick={runningItem.onView}
                                                    >
                                                        查看狀態
                                                    </button>
                                                ) : (
                                                    <button
                                                        className={primaryButton}
                                                        disabled={disabled}
                                                        onClick={() => onLoad(item.id)}
                                                    >
                                                        編輯活動
                                                    </button>
                                                )}
                                                <button
                                                    className={secondaryButton}
                                                    disabled={disabled || mutationsDisabled}
                                                    onClick={() => onRemove(item.id)}
                                                >
                                                    刪除
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
