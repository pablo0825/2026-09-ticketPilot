import type { KlookActivityRecord } from "../../../../config/activityStore.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";

export type ActivityListEntry = KlookActivityRecord & { executionStatus: ActivityExecutionStatus };

interface Props {
    activities: ActivityListEntry[];
    homeStatus: string;
    isSimulation: boolean;
    locked: boolean;
    blocked: boolean;
    onNew: () => void;
    onViewRun: () => void;
    onLoad: (id: string) => void;
    onRemove: (activity: ActivityListEntry) => void;
}

export function ActivityList({
    activities,
    homeStatus,
    isSimulation,
    locked,
    blocked,
    onNew,
    onViewRun,
    onLoad,
    onRemove,
}: Props) {
    return (
        <div className="card">
            <div className="section-title">
                <h2>活動列表</h2>
                <button id="new" disabled={blocked} onClick={onNew}>
                    新增活動
                </button>
            </div>
            <p id="homeRun" hidden={!homeStatus}>
                {homeStatus}
            </p>
            <button id="viewRun" className="secondary" hidden={!homeStatus} disabled={locked} onClick={onViewRun}>
                {isSimulation ? "查看模擬狀態" : "查看目前狀態"}
            </button>
            <p id="emptyActivities" hidden={activities.length > 0}>
                尚未儲存活動，請新增活動。
            </p>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            {["活動名稱", "演出日期", "演出時間", "執行狀態", "操作"].map(title => (
                                <th key={title}>{title}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody id="activities">
                        {activities.map(item => {
                            const sessions = new Set(
                                item.settings.targets.map(target => `${target.date} ${target.time}`),
                            );
                            return (
                                <tr key={item.id}>
                                    <td>{item.settings.eventName}</td>
                                    <td>{sessions.size === 1 ? item.settings.targets[0]!.date : "多個場次"}</td>
                                    <td>{sessions.size === 1 ? item.settings.targets[0]!.time : "多個場次"}</td>
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
                                    <td>
                                        <button disabled={blocked} onClick={() => onLoad(item.id)}>
                                            使用活動
                                        </button>
                                        <button className="secondary" disabled={blocked} onClick={() => onRemove(item)}>
                                            刪除
                                        </button>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
