import { ticketPlusFlowType } from "../../../../config/ticketPlusActivity.js";
import type { TicketPlusActivityRecord } from "./formModel.js";
import type { ActivityExecutionStatus } from "../../../purchaseRuns.js";
import type { TicketPlusStepsView } from "../../shared/runs/ticketPlusSteps.js";

export type ActivityListEntry = TicketPlusActivityRecord & { executionStatus: ActivityExecutionStatus | "待重新載入" };
interface Props {
    activities: ActivityListEntry[];
    disabled: boolean;
    mutationsDisabled: boolean;
    onNew: () => void;
    onLoad: (id: string) => void;
    onRemove: (item: ActivityListEntry) => void;
    // 正在使用購票瀏覽器的活動；這一列顯示即時狀態與查看狀態按鈕。
    running?: { id: string; badge: TicketPlusStepsView["badge"]; viewDisabled: boolean; onView: () => void };
}

export function ActivityList({ activities, disabled, mutationsDisabled, onNew, onLoad, onRemove, running }: Props) {
    return (
        <div className="card">
            <div className="section-title">
                <h2>TicketPlus 活動列表</h2>
                <button id="new" disabled={disabled || mutationsDisabled} onClick={onNew}>
                    新增活動
                </button>
            </div>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            {["活動名稱", "購票流程", "執行狀態", "操作"].map(label => (
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
                                <tr key={item.id} className={runningItem ? "running-row" : undefined}>
                                    <td>{item.settings.eventName}</td>
                                    <td>{ticketPlusFlowType(item.settings) === "lottery" ? "登記抽選" : "購票"}</td>
                                    {runningItem ? (
                                        <td>
                                            <span className={`status-badge ${runningItem.badge.tone}`}>
                                                {runningItem.badge.text}
                                            </span>
                                        </td>
                                    ) : (
                                        <td
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
                                        {runningItem ? (
                                            <button disabled={runningItem.viewDisabled} onClick={runningItem.onView}>
                                                查看狀態
                                            </button>
                                        ) : (
                                            <button disabled={disabled} onClick={() => onLoad(item.id)}>
                                                編輯活動
                                            </button>
                                        )}
                                        <button
                                            className="secondary"
                                            disabled={disabled || mutationsDisabled}
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
