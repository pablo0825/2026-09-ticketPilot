# TicketPlus 票區展開與張數 DOM 實站觀察

## 範圍與來源

2026-10-14（Asia/Taipei），使用 Codex 側邊瀏覽器操作使用者提供的頁面：

<https://ticketplus.com.tw/order/75a694bf61cb28f0e24835916cfae36e/cc7bebaffee949042a01105dc2eb821c>

活動：2026-27 BABYMONSTER WORLD TOUR [CHOOM] IN TAIPEI (11/22場次)。
場次：2026-11-22 18:00，台北小巨蛋。
觀察目標：黃3A區4200／全票／NT.4,200。

使用者授權更新觀察、加減張數，但明確要求不按下一步。實際操作為更新票數一次、展開票區一次、加號一次、減號一次；最終恢復零張，停留原 order 頁。未提交選票、未進入排隊或資料頁、未付款。
本次只修改文件，沒有執行專案 runner，也沒有驗證既有 reader 或操作模組支援這個版型。

## 操作與變化

| 狀態 | 黃3A區標頭 | 全票張數 | 加號 | 減號 | 下一步 | 清除選擇／電腦選位 |
| --- | --- | --- | --- | --- | --- | --- |
| 初次觀察，票區未展開 | 剩餘 0 | 未展開，未讀取 | 未觀察 | 未觀察 | disabled | disabled |
| 更新票數並展開票區 | 剩餘 1 | 0 | 無 disabled，data-count="0" | 無 disabled，灰色 | disabled | disabled |
| 加號一次後 | 剩餘 0 | 1 | disabled，data-count="-1" | 無 disabled，主色 | 啟用 | 啟用 |
| 減號一次後 | 剩餘 1 | 0 | 無 disabled，data-count="0" | 無 disabled，灰色 | disabled | disabled |

更新前所有可讀票區均顯示剩餘 0；更新後黃3A區顯示剩餘 1。更新的即時 AX 快照中，「更新票數」曾暫時沒有名稱，下一次取樣恢復；未確認對應 DOM 或可靠的刷新完成訊號，不應用此現象作完成條件。

加減後標頭剩餘數隨選取張數 1→0→1。這只證明當次 UI 變化，不證明伺服器已預留、庫存扣除或放回，也不能據此定義其他活動的庫存語意。
下一步啟用只代表控制項狀態，不能代替活動、場次、票區、票種與張數核對。

## 實際 DOM 結構

本頁以價格群組包住票區展開面板，與 [先前的直接票種列紀錄](ticketplus-dom.md) 不同。
票區按鈕為 `button.v-expansion-panel-header`，其直接父層為 `.v-expansion-panel`。
展開後兩者都有 `aria-expanded="true"`，分別增加 `v-expansion-panel-header--active` 與 `v-expansion-panel--active v-item--active`。

票區標頭 `.row.no-gutters` 內包含票區直接文字、庫存 `small.ml-1` 及右側價格。
初次讀取另一個零庫存票區「黃3C區800」時，庫存有 `soldout` class；黃3A區加一張後雖顯示剩餘 0，卻仍只有 `ml-1`。不可把 class 與數字任一訊號單獨推論成已售完。

展開內容位於 `.v-expansion-panel-content > .v-expansion-panel-content__wrap`。
本次全票列為 `.row.no-gutters`，名稱是左欄的 `span`「全票」，價格是 `.ticket-price.text-body-1`。
它沒有先前版型的 `.row.py-1.py-md-4.rwd-margin.no-gutters` 票種列 class。

計數器 `.count-button` 依序包含：

1. 無文字名稱的 button，內含 `i.mdi-minus[aria-hidden="true"]`。
2. 張數文字 div。
3. 無文字名稱的 button，內含 `i.mdi-plus[aria-hidden="true"]`。

零張時，減號 button 有 `grey-1`，圖示有 `grey-3--text`，但沒有原生 disabled；未測試零張再減的行為。不能將灰色直接等同 `isEnabled() === false`。
一張時，加號增加 `disabled="disabled"`、`v-btn--disabled`；`data-count` 從 `0` 變成 `-1`，`data-limit="true"` 維持不變。這些 data 屬性的業務含義未確認，不能當作已選張數或購買上限。
減回零張後，加號移除 disabled，data-count 回到 0。

下一步的最小結構（省略其他 class 與動態 Vue 屬性）：

```html
<!-- 零張：加票前與減票後 -->
<button type="button" class="nextBtn v-btn--disabled disabledBtn" disabled="disabled">
    <span class="v-btn__content">下一步</span>
</button>

<!-- 一張：移除 disabled 與上述停用 class -->
<button type="button" class="nextBtn elevation-0">
    <span class="v-btn__content">下一步</span>
</button>
```

## 定位注意事項與限制

票區按鈕的 accessible name 含剩餘數與價格，會隨加減改變。觀察時用加票前完整名稱讀加票後計數器曾逾時；當時加票已成功，重新讀取 AX 與新標頭 DOM 後確認一張，沒有重按加號。

`.v-expansion-panel` 配合 descendant `has` 篩選目標標頭會同時命中價格群組與內層票區，本次 count 為 2。不可直接假定面板唯一；實作前應由唯一標頭限定其直接父層，並再驗證票種列與按鈕唯一性。此次實際加減定位的最終按鈕各唯一，未使用 first 或 force。

本次只驗證一個票區的一張加減，未測試多張、跨票區、零張減號、清除選擇、選票送出、排隊、錯誤恢復與 checkout。沒有依此次觀察更改既有購票程式；後續若新增版型支援，仍需本機 fixture、型別檢查、相關測試與獨立 review。
