# 個人資料頁預訂摘要 DOM（2026-09-29）

只讀取摘要，未填個資、未操作付款。網址路徑 `/zh-TW/event/payment/`；不保存購物車識別碼。

## 定位

- 摘要容器：`.product`，須包含 `h2.product_name`，使用時應驗證唯一且可見。
- 活動名稱：`h2.product_name`。
- 票種：`.product_package_name`。
- 摘要明細：`.main .item`。
- 日期列：`.item_label` 文字「日期」，同列 `.item_value` 內容 `2026-10-03 12:00:00`。
- 數量列：`.item_label` 文字「門票（不含全家取票手續費NT$30/每筆）」，同列 `.item_value` 內容 `1`。
- 座位列：此次無 `.item_label`，`.item_value` 內容 `A1區, 第4排, 15號座位`。
- 總價：`footer .item_value`，此次 `NT$ 4,880`。不要將總價列當座位或數量。

## 本次觀察值

- 活動：2026 BOYFRIEND FAN-CONCERT <Our 15th Season> IN TAIPEI
- 場次：2026-10-03 12:00:00
- 票種：A區（NT$4,880）
- 張數：1
- 座位：A1區，4排，15號。與先前本次配位觀察相同。
- 填寫資料倒數讀取時為 0:04:14，與選位保留倒數為不同階段。

## 實作注意

摘要應限定在上述容器；欄位不存在、重复或座位格式未知時不可判成功。
本次只有一張票，多張票如何排列座位仍未觀察。
活動設定目前只有 eventUrl，若新增活動名稱核對，須先建立預期名稱來源，不能直接拿頁面名稱自我比對。
摘要核對已實作於 bookingSummary.ts；仍待此次版本真站驗證。容器可見但欄位尚未完整時會安全停止，不會以部分資料判成功。

## 聯絡資料欄位 DOM

僅讀取結構、標籤與屬性，未讀取輸入值或變更表單。

| 欄位 | 定位 | 必填依據 |
| --- | --- | --- |
| 名 | input[placeholder="請填寫名字"] | 群組 .klk-form-item-is-required |
| 姓 | input[placeholder="請填寫姓氏"] | 同上 |
| 國際電話區碼 | .os_traveler_info__region_code 的 input[placeholder="請選擇"] | 同上 |
| 手機號碼 | .os_traveler_info__phone 的 input[placeholder="請填寫手機號碼"] | 同上 |
| 電子信箱 | .os_traveler_info__email 的 input[placeholder="請輸入"] | 同上 |

- 上述文字 input 沒有 name、id、required、aria-required 或 maxlength；必填由外層元件標示，不能單靠 input.required 判定。
- 電子信箱 type 為 text；尚未觸發網站驗證，因此未確認完整格式規則。
- 電話區碼為自訂 .klk-select，不是原生 select；尚未展開選項。
- 發票／收據區有 button.invoice-button，文字「填寫」；未開啟，內部欄位未知。
- 優惠通知 checkbox 可見且 aria-checked=true；不應將其視為必要聯絡欄位或自動替使用者變更偏好。
- 「我同意以下所有條款」checkbox 存在 DOM 但本次不可見；不能依 DOM 存在就勾選。
- button.submit-button 文字「前往付款」，本次未操作。

## 個人資料頁預留過期（2026-09-29）

- 當時路徑仍為 `/zh-TW/event/payment/`。
- `.klk-modal-alert .klk-modal-content-inner` 顯示「未於時限內確認，票券預留失敗」。
- 彈窗內 `button.confirm-button` 文字是「確認」，不是「OK」。
- 背後仍有預訂資料／聯絡資料／發票收據區；「前往付款」button 的 disabled=false。不能用該按鈕 enabled 或摘要仍存在判定預留有效。
- 此次僅讀取 DOM，未讀個資輸入值、未點按鈕；按「確認」後目的地、資料是否保留仍未知。
- 和選位過期使用相同提示文字，必須以所在頁面／階段區分，不可只按文字共用恢復流程。
- 現行 main 在 PERSONAL_INFO_READY 後不再監測；此情況尚未由重試流程處理。

## 發票／收據編輯彈窗（2026-09-29）

使用者填妥聯絡資料後手動開啟；助理只讀結構，不記錄輸入值或操作儲存。

- 可見容器 `.klk-modal.klk-modal-scrollable`；標題「編輯發票／收據資料」。實作時需以標題限定唯一可見彈窗。
- `[role="radio"]` 有「個人」與「統編」；本次「個人」aria-checked=true。
- 個人類型欄位：電子信箱，`input[placeholder="請輸入電子信箱"]`，外層 `.klk-form-item-is-required`。
- 取消：`button.form-footer-cancel`，可操作。
- 儲存：`button.form-footer-confirm`，可操作。
- 未切換「統編」，該類型額外欄位未知；未觸發驗證，不能只因儲存按鈕啟用推論資料有效。
- 編輯彈窗屬收據設定，不是逾時重試條件。開啟時應先等待使用者完成或取消，不能在遮罩後继续操作付款。

## 電話區碼下拉展開（2026-09-29）

- 群組：`.os_traveler_info__region_code`。
- 展開時：`.klk-select.klk-select-expand`。
- 觸發區：`.klk-select-reference`，內有 placeholder「請選擇」的文字 input；本次未測試輸入搜尋，不能假設可搜尋。
- 選單：`.klk-select-dropdown`，捲動容器 `.klk-select-dropdown-inner.klk-scrollbar-y`。
- 分組：`.klk-option-group`，標題 `.klk-option-group-label`，此次有 Frequently 與其他國家/地區。
- 選項：div.klk-option，文字在 span.klk-option-label；沒有 role=option 或原生 select。
- 台灣選項文字「台灣 (+886)」，本次 class 含 klk-option-selected。
- klk-option-hovering 只表示滑鼠所在項目，不能當成已選。
- 後續若實作：限定電話區碼群組，按完整選項文字匹配，驗證唯一及 selected class。不可使用原生 selectOption。
- 本次未讀取手機號碼、未更改選項。

## 提交到付款頁（2026-10-01）

使用者手動完成一次提交，觀察到：
- 個人資料頁可見按鈕「前往付款」，class 包含 `submit-button`；提交前沒有可見 `.klk-modal`。
- 提交後進入同站 `/zh-TW/order-checkout/`，query 有 `order_no`；不保存實際訂單編號。
- 可見 `.payment_type-name` 包含 LINE Pay、信用卡/記帳卡、Google Pay。
- 可見 `.oc_submit_price` 為 `NT$ 4,880`；「確認付款」按鈕可見且可操作。
- 同一 DOM 仍存在隱藏的「前往付款」及其他按鈕，定位須限定可見元素。

提交由 `contactForm.ts` 的 `submit()` 負責；`paymentPage.ts` 獨立核對網址、付款選項、金額與按鈕。
`contactForm.ts` 提供不重新填寫的 `verify`，供提交前再次核對；main 的提交與付款頁核對在 recovery 範圍外。
有 contact.local.json 時，核對後送出並停在付款頁；沒有設定時仍停在個人資料頁。
提交結果未知或付款頁核對失敗時停止，不自動重送、不重跑購票、不按確認付款。
本次實作以本機 fixture 測試；新的自動提交程式仍待使用者實站驗證。
