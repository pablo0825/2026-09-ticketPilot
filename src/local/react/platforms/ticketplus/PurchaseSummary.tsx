import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";
import type { ReactNode } from "react";

interface Props {
    settings?: TicketPlusActivitySettings;
    reason: string;
    disabled: boolean;
    onStart: () => void;
    children?: ReactNode;
    confirmed: boolean;
    onConfirm: (confirmed: boolean) => void;
}

export function PurchaseSummary({ settings, reason, disabled, onStart, children, confirmed, onConfirm }: Props) {
    return (
        <section className="card" aria-label="活動摘要">
            <h2>活動摘要</h2>
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
                </div>
            )}
            {children}
            <label className="check">
                <input
                    type="checkbox"
                    disabled={disabled}
                    checked={confirmed}
                    onChange={event => onConfirm(event.target.checked)}
                />
                我已確認活動、順位與張數，並了解程式會停在填寫資料頁，後續由我手動處理。
            </label>
            {reason && <p role="status">{reason}</p>}
            <button type="button" disabled={disabled || Boolean(reason) || !confirmed} onClick={onStart}>
                開始購票
            </button>
        </section>
    );
}
