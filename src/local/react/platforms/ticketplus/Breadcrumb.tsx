interface Props {
    // 有活動名稱時是編輯頁（三層），沒有時是活動列表（兩層）。
    activityTitle?: string;
    disabled: boolean;
    showLockChip: boolean;
    onPlatforms: () => void;
    onList: () => void;
}

const lockReason = "購票瀏覽器使用中或模擬執行中，暫時無法變更活動設定";

export function Breadcrumb({ activityTitle, disabled, showLockChip, onPlatforms, onList }: Props) {
    return (
        <nav className="breadcrumb" aria-label="目前位置">
            <button className="breadcrumb-link" aria-label="返回平台首頁" disabled={disabled} onClick={onPlatforms}>
                首頁
            </button>
            <span aria-hidden="true">/</span>
            {activityTitle === undefined ? (
                <span className="breadcrumb-current" aria-current="page">
                    TicketPlus
                </span>
            ) : (
                <>
                    <button
                        id="homeButton"
                        className="breadcrumb-link"
                        aria-label="返回 TicketPlus 活動列表"
                        disabled={disabled}
                        onClick={onList}
                    >
                        TicketPlus
                    </button>
                    <span aria-hidden="true">/</span>
                    <span className="breadcrumb-current" aria-current="page" title={activityTitle}>
                        {activityTitle}
                    </span>
                </>
            )}
            {/* 完整原因平時只給螢幕閱讀器；滑鼠移上去或鍵盤聚焦時顯示成提示框。 */}
            {showLockChip && (
                <span className="lock-chip" role="note" tabIndex={0}>
                    <span aria-hidden="true">🔒 </span>設定已鎖定
                    <span className="visually-hidden">：</span>
                    <span className="lock-chip-tip">{lockReason}</span>
                </span>
            )}
        </nav>
    );
}
