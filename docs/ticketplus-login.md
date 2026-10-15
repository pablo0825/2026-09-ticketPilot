# TicketPlus 首頁登入觀測

2026-10-15 在側邊瀏覽器實測首頁登入及 390px 窄版選單，沒有進入購票。

- 未登入時，首頁會員入口顯示「會員登入」；登入表單在首頁開啟。
- 使用者完成登入後仍停留在 `https://ticketplus.com.tw/`，表單消失，會員列改成遮罩帳號與「登出」。
- 桌面會員列位於 `header.headerApp`，帳號與登出位於同一 `.font-weight-bold` 容器。
- 窄版關閉選單時，`nav.v-navigation-drawer--close` 仍保留 `.drawerItem` DOM，但移到畫面外。不能用元素存在或 `getClientRects()` 非空作為可見證據。
- 窄版 `header.headerApp button.mdi-menu` 展開後，同一 `.drawerItem` 會員列包含遮罩帳號與登出；`button.mdi-close` 可關閉。

登入觀測只讀會員區的固定文字與遮罩格式，不讀輸入值、cookie、storage，不輸出帳號或原始 DOM。空白、局部標記、衝突或關閉選單皆不能當登入成功。登入等待與活動內容核對是不同的條件；登入成功不證明活動頁已載入完成。

這次觀測不代表先前活動全頁擷取的 `capture-dom / other-read-error` 已修復；原活動資料解析與購票核對仍需獨立通過。
