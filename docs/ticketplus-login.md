# TicketPlus 首頁登入觀測

2026-10-15 在側邊瀏覽器實測首頁登入及 390px 窄版選單，沒有進入購票。

- 未登入時，首頁會員入口顯示「會員登入」；登入表單在首頁開啟。
- 使用者完成登入後仍停留在 `https://ticketplus.com.tw/`，表單消失，會員列改成遮罩帳號與「登出」。
- 桌面會員列位於 `header.headerApp`，帳號與登出位於同一 `.font-weight-bold` 容器。
- 窄版關閉選單時，`nav.v-navigation-drawer--close` 仍保留 `.drawerItem` DOM，但移到畫面外。不能用元素存在或 `getClientRects()` 非空作為可見證據。
- 窄版 `header.headerApp button.mdi-menu` 展開後，同一 `.drawerItem` 會員列包含遮罩帳號與登出；`button.mdi-close` 可關閉。

登入觀測只讀會員區的固定文字與遮罩格式，不讀輸入值、cookie、storage，不輸出帳號或原始 DOM。空白、局部標記、衝突或關閉選單皆不能當登入成功。登入等待與活動內容核對是不同的條件；登入成功不證明活動頁已載入完成。

這次觀測不代表先前活動全頁擷取的 `capture-dom / other-read-error` 已修復；原活動資料解析與購票核對仍需獨立通過。

## 登入等待診斷

首次觀測，以及 state、reason、routeKind 或會員標記計數改變時，輸出「登入狀態觀測變化」。只有耗時／次數增加時不重複輸出。標記包含 headers（可見頁首）、accounts（符合遮罩格式且與登出配對）、logouts、logins、dialogs、menuButtons、openDrawers；計數不是帳號或畫面原文。

登入等待停止（包括手動停止）會輸出「登入等待停止」，最終結果另附「登入停止診斷」：實際等待耗時、完成觀測次數及最後一次完成的快照。沒有完成過觀測時次數為 0，不虛構快照；讀取中斷時保留的是前次完成觀測，不代表停止瞬間的 DOM。停止後不為診斷重新讀取頁面。日誌仍受既有執行紀錄長度上限限制。

例如 `state=unknown` 且 `accounts=1, logouts=1, logins=0, dialogs=1`，代表會員標記存在，但可見對話框使已登入條件未通過；不表示登入一定失敗。通知失敗不覆蓋停止原因，登入判斷、等待期限與購票動作均保持不變。
