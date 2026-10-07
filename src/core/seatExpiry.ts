// 只代表尚未嘗試座位確認時，已讀到明確的預留過期提示。
// 確認點擊或導頁失敗不可轉成此錯誤。
export class SeatExpiredBeforeConfirmationError extends Error {}
