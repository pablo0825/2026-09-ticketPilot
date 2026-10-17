# TicketPlus 票區面板版型支援與更新票數空窗修正 設計

日期：2026-10-17（Asia/Taipei）

## 目的與原因

TicketPlus 選票頁（`/order/<eventId>/<sessionId>`）有兩種版型：

- **票種列版型**：每個票種是一列，名稱、庫存、價格、計數器都在同一列。現有程式只支援這種。
- **票區面板版型**：外層是可展開的票區（VIP 區、A 區…），票區標題有庫存與價格；展開後才出現票種列與計數器。

2026-10-17 12:00 的實際執行（LOOKMHEE SONYA，設定 `ticketType: "B 區"`）進入選票頁後，reader 讀到 `ticketRows: 0`、`nextButtons: 1`，回 `incomplete-data`，最後以 `arrival-timeout` 停止。原因是票種列只用固定 class `.row.py-1.py-md-4.rwd-margin.no-gutters` 辨識，票區面板版型沒有這組 class。

同日觀察也發現：現有「更新票數」完成判斷要求空窗時每列計數器消失，但今天兩種版型的實站樣本中，空窗期計數器都留在畫面上，只有庫存文字消失。只要「全部順位沒票就更新」一走到更新，就可能等不到完成。使用者決定一併修正。

## 實站證據（2026-10-17，登入後唯讀觀察；只點過展開票區與更新票數）

### 票種列版型（漂遊者 `/order/524b687d…/507e7a39…`）

```html
<div class="row py-1 py-md-4 rwd-margin no-gutters [soldout]">
    <div class="font-weight-medium">超早鳥三日毛巾套票 <span class="v-chip"><span>熱賣中</span></span></div>
    <div>NT. 2,980</div>
    <div class="count-button"><button>(mdi-minus)</button><div>0</div><button>(mdi-plus)</button></div>
</div>
```

- 有票：`熱賣中`（v-chip）或 `剩餘 N`。
- 售完列：`剩餘 0`（span）＋ `已售完`（`span.disabled-text`），沒有計數器，列帶 `soldout` class。

### 票區面板版型（LOOKMHEE `/order/7f9c57d1…/e62c67b3…`）

```html
<div class="v-expansion-panels seats-area">
    <div class="v-expansion-panel">
        <button class="v-expansion-panel-header" [aria-expanded="true"]>
            <div class="row no-gutters">
                <div class="col-8"><div class="area-color"></div><div class="d-flex align-center"> B 區 <small>剩餘 12</small> 或 <span class="v-chip">熱賣中</span></div></div>
                <div class="col-4">NT.7,000</div>
            </div>
        </button>
        <div class="v-expansion-panel-content"><div class="v-expansion-panel-content__wrap">
            <div class="row no-gutters [soldout]">
                <span>預售票</span> <div class="ticket-price">NT. 7,000</div>
                <div class="count-button">…</div>  或  <span class="disabled-text">暫無票券</span>
            </div>
        </div></div>
    </div>
</div>
```

- 收合時 `aria-expanded` 不存在，`v-expansion-panel-content` 不在 DOM，**沒有票種列與計數器**。
- 票區標題庫存：`剩餘 N`（`small`，0 時常帶 `soldout` class）、`熱賣中`（v-chip）。標題上沒有看過「已售完」。
- 售完票區（VIP 區）展開後：`預售票`、價格、`暫無票券`，沒有計數器，列帶 `soldout` class。
- 10/14 紀錄（`docs/ticketplus-area-quantity-observation.md`）：自己選走最後一張時標題也變 `剩餘 0`，但沒有 `soldout` class。
- 名稱比對實測：整頁比對「元素自身文字完全等於名稱」，`B 區`、`預售票`、各票種名都唯一命中，沒有誤中較長文字。
- 一次只能展開一個票區：VIP 區展開時點開 B 區，VIP 區會自動收合。
- 收合曾展開過的票區後，`v-expansion-panel-content` 仍留在 DOM，`display: none`；從未展開的票區沒有 content。
- 按更新票數時，已展開的 B 區保持展開，票種列與計數器全程都在。

### 文字語意（使用者說明）

- `已售完`：真的沒票。
- `暫無票券`：其他購票人還在流程中，票被暫時保留，之後可能釋出。

### 更新票數空窗（各點一次）

| 版型 | 0ms | 約 80–200ms 空窗 | 約 220–250ms | 約 730–750ms |
| --- | --- | --- | --- | --- |
| 票種列 | 按鈕消失、出現讀取圈 | 庫存、已售完消失；名稱、價格保留；**計數器保留，售完列甚至暫時出現計數器** | 資料恢復 | 按鈕恢復 |
| 票區面板 | 同上 | 所有票區標題的庫存消失；名稱、價格保留；已展開票區內的票種列與計數器保留 | 資料恢復（C 區 6→20） | 按鈕恢復 |

10/16 的樣本（`docs/ticketplus-dom.md`「更新票數完成辨識」）記錄為空窗時「庫存、已選張數與售完標示消失」，與今天的計數器保留不同。兩種都要接受。

## 目標

1. 票區面板版型可以完整讀取、選票、送出，並維持現有嚴格程度。
2. 票種列版型行為不變（既有 fixture 與測試照樣通過）。
3. 辨識「暫無票券」為獨立狀態，與「已售完」同樣跳下一順位，但不標成售完。
4. 更新票數完成判斷符合兩種版型的實站空窗。

## 非目標

- 不核對價格與幣別（依 AGENTS.md 由使用者人工確認）。
- 不支援一個票區內有多種票種的選擇（使用者沒遇過）；遇到即停止。
- 不改 GUI 欄位與設定格式。
- 不改恢復、排隊、資料頁、付款頁流程。

## 反目標（做到會算失敗）

- 把 `暫無票券`、`剩餘 0`、缺列、讀取不完整標成「售完」。
- 為了找到目標而放寬比對：取第一個、子字串比對、忽略重複。
- 點擊已展開的票區標題（會把它收合）、重複點展開、自動重試選票送出。
- 讀取函式產生任何點擊。

## 已決定事項

**使用者決定的：**

- `ticketType` 在票區面板版型填**票區名稱**（例「B 區」）；票種列版型照舊填票種名稱。GUI 不加欄位。
- 用「價格篩出全部、名稱挑出目標」辨識，不依元素標籤。
- `已售完` 與 `暫無票券` 都跳下一順位；全部順位沒有可買票時，照現有規則更新票數再從第一順位重試。
- 更新票數完成判斷的修正一併放進本次。
- 票區標題 `剩餘 0`、票種列有計數器且已選 0 張 → 視為暫無票券，跳下一順位。

**助理決定的（使用者可推翻）：**

- 票區內票種多於一種 → 停止並說明（`ticket-ambiguous` 類）。
- 只看票區標題 `剩餘 0` 不下售完結論；以展開後票種列的文字為準。
- 「是不是票區」用 Vuetify 元件 class（`.v-expansion-panel`、`.v-expansion-panel-header`）判斷。它們是元件語意 class，比 `py-1 py-md-4` 這類排版 class 穩定。列本身不靠 class 找。
- 兩種版型都認 `已售完` 與 `暫無票券`，即使目前各只看過一種；未觀察到的組合寫進文件標「未觀察」。

## 設計

### 1. 讀取：價格錨點列舉（`domSnapshot.ts` + `ticketSelectionPage.ts`）

維持一次同步 `page.evaluate` 的整頁快照。把固定 class 選票種列，改成：

1. 找所有可見、無可見子元素、文字符合 `^NT\.?\s*[\d,]+$` 的元素（價格）。
2. 價格位於 `.v-expansion-panel-header` 內 → **票區**：讀票區名稱（標題內名稱容器的直接文字）、庫存標記、`aria-expanded`。
3. 其他價格 → **票種列**：從價格往上，找到「剛好只含這一個價格」的最外層容器，但不越過 `.v-expansion-panel-content` 或票區界線。讀名稱、庫存標記、售完文字、計數器（`.count-button` 內 minus／數字／plus，沿用現有讀法）。若位於 `.v-expansion-panel` 內，記下所屬票區名稱。
4. 庫存標記去重複（v-chip 外框與內文會各讀到一次）。

名稱取法：票種列中，扣除價格、庫存標記、售完文字、計數器數字之後，唯一剩下的非空直接文字。0 個或多個 → 該列不完整。

快照輸出同時包含 `areas` 與 `tickets` 兩組，型別由實作者決定。語意如下：

- 票區：`name`、`remaining`（數字或 null＝熱賣中）、`expanded`、所屬票種列。
- 票種列：`area`（null 表示票種列版型）、`name`、`saleStatus: "selling" | "sold-out" | "unavailable"`、`selectedQuantity`、`canIncrease`、`canDecrease`、`remainingQuantity`。

**完整性規則（任一不符 → `incomplete-data` 或 `ambiguous-data`，不推論售完）：**

- 同頁同時有票區與不屬於票區的票種列 → 不完整。
- 票種列：`剩餘 N`／`熱賣中` 恰一個且有唯一計數器 → `selling`；`已售完`、無計數器 → `sold-out`；`暫無票券`、無計數器 → `unavailable`；其他組合 → 不完整。
- 票區面板中的票種列，庫存以票區標題為準。標題 `剩餘 0` 加上票種列有計數器時：
  - 已選張數 > 0 → `selling`（自己選走最後一張，10/14 已觀察）。
  - 已選張數 = 0 → `unavailable`，跳下一順位（使用者決定；此畫面尚未觀察，推測是頁面未更新、他人剛取走最後一張）。
- 已展開的票區必須恰有一列票種；收合的票區沒有票種列是正常的。

`readTicketPlusPage` 的其他頁面分類（`pageState.ts`、`activityLoading.ts`、`pageReadiness.ts` 以 `tickets.length` 判斷「有選票內容」）改成看「票種列或票區任一存在」。價格錨點只在選票內容範圍內找，排除活動頁、資料頁與付款頁的摘要價格（實作者需確認付款摘要 `.row.py-2.py-md-3` 不會被誤認，必要時限定在 order 路徑）。

### 2. 目標比對

- 票種列版型：`ticket.area === null && ticket.name === ticketType`，唯一。
- 票區面板版型：`area.name === ticketType`，唯一；目標票種為該票區內唯一的票種列。
- 0 個 → `ticket-missing`；多個 → `ticket-ambiguous`；票區內多於一種票 → `ticket-ambiguous`。
- 名稱完整相等，大小寫、全半形、內部空白敏感（沿用現有規則）。

`ticketPriority.ts`、`ticketQuantity.ts`、`submissionValidation.ts` 目前都寫 `ticket.name === ticketType`，改成共用一個比對函式。

### 3. 展開票區（新的獨立步驟）

- **觸發**：順位挑到的目標是票區面板版型，且該票區 `expanded === false`。
- **動作**：點該票區標題一次。點擊前重新讀快照，確認仍未展開且標題唯一；已展開就不點。
- **完成條件**：同一票區 `expanded === true`，且其內恰一列完整票種（有計數器，或 `已售完`／`暫無票券`）。
- **失敗**：期限內沒完成 → 停止並說明，不重點。
- **歸屬**：點擊放在新的單一職責模組（例 `areaExpansion.ts`），由 `ticketPriority.ts` 在挑到收合的目標票區時呼叫，共用該次順位挑選的期限與停止控制。`ticketPriority.ts` 的註解改為「讀取唯讀；唯一的點擊是交給展開模組展開目標票區」。
- **次數**：每次「輪到某順位」最多點一次展開。順位前進到下一個、或更新後從第一順位重來時，各自是新的一次嘗試，可以再展開一次；這不是恢復預算，與 AGENTS.md 的恢復次數無關。
- 展開另一個票區會收合目前展開的票區（已觀察），所以每次輪到收合的目標都可能需要展開；之後一律重讀快照。

展開完成後回到順位判斷：`selling` → 交給張數調整；`sold-out`／`unavailable` → 下一順位。

### 4. 售完與暫無票券的流程

- `ticketPriority.ts`：`sold-out` 與 `unavailable` 都 `continue`；全部順位都屬這兩種 → 拋出現有的「全部沒票」錯誤，讓 cycle 走更新流程。錯誤代碼可保留 `all-targets-sold-out` 以維持相容，但 `ticketPlusPresentation.ts` 的使用者文案改成「目標皆已售完或暫無票券」，不得只寫「售完」。
- `ticketQuantity.ts`：目標 `unavailable` 時停止，用新的原因代碼，不用 `ticket-sold-out`。
- `submissionValidation.ts`：仍要求目標 `selling`。

**其他票種必須為 0 張的檢查**：收合過的票區 content 會以 `display: none` 留在 DOM（已觀察）。快照另外掃描所有 `.v-expansion-panel-content` 內的計數器張數，**不套用可見性過濾**，只用於這項檢查；任何非目標票區張數非 0 就停止。從未展開的票區沒有 content，視為 0 張。

**張數上限**：票區面板版型的 `remainingQuantity` 取票區標題的數字（`熱賣中` 為 null）。張數調整維持現有做法，只依 `canIncrease` 判斷能否再加，不另外拿張數與剩餘數比較。

### 5. 點擊定位（`ticketQuantity.ts:156`、`ticketSubmission.ts:230`）

移除 `.row.py-1.py-md-4.rwd-margin.no-gutters` 與 `.font-weight-medium` XPath。在瀏覽器內用與 reader 相同的規則定位目標票種列，並維持現有嚴格度：

- 目標列唯一、名稱完全相等、目前張數符合上次確認值。
- 加減按鈕在該列計數器內唯一（`mdi-plus`／`mdi-minus` 圖示）。
- 「下一步」核對目標列張數正確後才按，只送一次。

做法（共用列定位 helper、在 evaluate 中標記節點，或 Playwright locator 組合）由實作者決定，但讀取與點擊必須用同一套列辨識規則。

### 6. 更新票數空窗判斷（`domSnapshot.ts` 監測、`refreshReadiness.ts`）

把「每列無計數器、無庫存」改為：

- **空窗證據**：點擊本次更新按鈕後，曾出現一次快照，其中所有票種列（票種列版型）或所有票區標題（票區面板版型）的庫存與售完文字（`剩餘 N`、`熱賣中`、`已售完`、`暫無票券`）同時消失。**計數器存在與否不列入條件。**
- **名稱比對**：票種列版型比對所有票種名；票區面板版型只比對票區名稱集合。展開票區內票種列的文字（含 `暫無票券`）不要求消失，因為沒有觀察到。
- `refreshReadiness` 的 pending「refresh-data-loading」同樣放寬為「名稱在、庫存文字全無」，計數器可有可無；有計數器時張數必須為 0，非 0 仍停止。
- 完成條件不變：按鈕消失證據、空窗證據、按鈕恢復可用、完整快照。

## 測試

使用 `node:test` 與 headless Playwright 本地 fixture：

- 新增票區面板版型 fixture（收合／展開、熱賣中、剩餘 N、剩餘 0＋暫無票券、剩餘 0＋自選最後一張）。
- `refreshPage.ts` 改為實站行為：空窗保留計數器、售完列暫時出現計數器。保留舊行為（計數器消失）樣本作為也要接受的情況。
- 涵蓋：名稱不符、同名票區、票區內多票種、兩種版型混在同頁、展開逾時、已展開不重點、暫無票券跳順位、全部暫無票券觸發更新、空窗判斷兩種版型、非目標票區張數非零停止、點擊次數（展開一次、送出一次）。
- 既有票種列版型測試全部照常通過。

## 留給實作者

- 快照與 `TicketRow` 型別的具體欄位命名、是否拆成新檔案（依 SRP）。
- 列容器往上找的停止規則細節，以及價格範圍限定方式。
- 點擊定位的技術手段。
- 新增停止原因代碼的命名與文案。

## 未驗證

- 票區面板版型實際選票、送出、排隊、到資料頁的完整流程。
- 票區面板版型是否出現 `已售完`；票種列版型是否出現 `暫無票券`。
- 展開票區內 `暫無票券`／`已售完` 的文字在更新空窗期是否消失。
- 慢速網路下的更新空窗時序。
