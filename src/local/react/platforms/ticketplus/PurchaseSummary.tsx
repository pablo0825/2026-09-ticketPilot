import type { TicketPlusActivitySettings } from "../../../../config/ticketPlusActivity.js";

interface Props {
    settings?: TicketPlusActivitySettings;
    reason: string;
    disabled: boolean;
    onStart: () => void;
}

export function PurchaseSummary({ settings, reason, disabled, onStart }: Props) {
    return (
        <section className="card" aria-label="購票前確認">
            <h2>購票前確認</h2>
            <p>以下為已保存的設定；請核對後再開始。開始後需到購票瀏覽器手動登入，再回來確認選票。</p>
            {settings && (
                <>
                    <p>活動：{settings.eventName}</p>
                    <p>活動網址：{settings.eventUrl}</p>
                    <ol>
                        {settings.targets.map((target, index) => (
                            <li key={index}>
                                順位 {index + 1}：{target.date} {target.time}／{target.ticketType}／{target.quantity} 張
                            </li>
                        ))}
                    </ol>
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
                </>
            )}
            <p>流程終點：填寫資料頁。後續資料、條款與付款由你手動處理。</p>
            {reason && <p role="status">{reason}</p>}
            <button type="button" disabled={disabled || Boolean(reason)} onClick={onStart}>
                開始購票
            </button>
        </section>
    );
}
