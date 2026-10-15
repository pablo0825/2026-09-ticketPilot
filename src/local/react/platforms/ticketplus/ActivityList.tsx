import type { TicketPlusActivityRecord } from "./formModel.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";

export type ActivityListEntry = TicketPlusActivityRecord & { executionStatus: ActivityExecutionStatus | "待重新載入" };
interface Props {
    activities: ActivityListEntry[];
    disabled: boolean;
    onNew: () => void;
    onLoad: (id: string) => void;
    onRemove: (item: ActivityListEntry) => void;
}

export function ActivityList({ activities, disabled, onNew, onLoad, onRemove }: Props) {
    return (
        <div className="card">
            <div className="section-title">
                <h2>活動列表</h2>
                <button id="new" disabled={disabled} onClick={onNew}>
                    新增活動
                </button>
            </div>
            {activities.length === 0 && <p>尚未儲存 TicketPlus 活動，請新增活動。</p>}
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            {["活動名稱", "演出日期", "演出時間", "執行狀態", "操作"].map(label => (
                                <th key={label} scope="col">
                                    {label}
                                </th>
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
                                        title={
                                            item.executionStatus === "已執行"
                                                ? "已執行不代表購票或付款成功。"
                                                : undefined
                                        }
                                    >
                                        {item.executionStatus || "尚無執行紀錄"}
                                    </td>
                                    <td>
                                        <button disabled={disabled} onClick={() => onLoad(item.id)}>
                                            編輯活動
                                        </button>
                                        <button
                                            className="secondary"
                                            disabled={disabled}
                                            onClick={() => onRemove(item)}
                                        >
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
