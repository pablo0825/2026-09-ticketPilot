import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";
import type { ReactNode } from "react";

interface Props {
    settings?: TicketPlusActivitySettings;
    reason: string;
    disabled: boolean;
    onStart: () => void;
    children?: ReactNode;
}

export function PurchaseSummary({ settings, reason, disabled, onStart, children }: Props) {
    return (
        <section className="card" aria-label="本次活動摘要">
            <h2>本次活動摘要</h2>
            <p>以下為已保存的設定；請核對後再開始。開始後需到購票瀏覽器手動登入，再回來確認選票。</p>
            {settings && (
                <div id="summary">
                    <div className="summary-field">
                        <span className="summary-label">活動名稱｜</span>
                        <span>{settings.eventName}</span>
                    </div>
                    <div className="summary-field">
                        <span className="summary-label">活動網址｜</span>
                        <a href={settings.eventUrl} title={settings.eventUrl} target="_blank" rel="noopener noreferrer">
                            {settings.eventUrl}
                        </a>
                    </div>
                    <h3>購票順位</h3>
                    <div className="summary-table-scroll" tabIndex={0} role="region" aria-label="購票順位">
                        <table>
                            <thead>
                                <tr>
                                    {["順位", "演出日期", "時間", "票種", "張數"].map(title => (
                                        <th key={title} scope="col">
                                            {title}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {settings.targets.map((target, index) => (
                                    <tr key={index}>
                                        <td>{index + 1}</td>
                                        <td>{target.date}</td>
                                        <td>{target.time}</td>
                                        <td>{target.ticketType}</td>
                                        <td>{target.quantity}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p>
                        最長執行時間：
                        {settings.maxRunMinutes === undefined ? "未設定全程期限" : `${settings.maxRunMinutes} 分鐘`}
                        （開始選場次前計時，人工登入與開賣等待不計入）
                    </p>
                    {settings.saleSchedule && (
                        <p>
                            開賣時間：{settings.saleSchedule.saleAt}；
                            {settings.saleSchedule.advanceSeconds === undefined
                                ? "僅等待，不刷新；已過時間則立即繼續。"
                                : `提前刷新 ${settings.saleSchedule.advanceSeconds} 秒（尚未支援執行）。`}
                        </p>
                    )}
                </div>
            )}
            {children}
            <p>流程終點：填寫資料頁。後續資料、條款與付款由你手動處理。</p>
            {reason && <p role="status">{reason}</p>}
            <button type="button" disabled={disabled || Boolean(reason)} onClick={onStart}>
                開始購票
            </button>
        </section>
    );
}
