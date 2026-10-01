# tickets_hunter 對 TicketPilot 的參考分析

分析日期：2026-09-28。上游依據：[bouob/tickets_hunter](https://github.com/bouob/tickets_hunter)，本次下載的 main HEAD 為 `9e2d1061b48706076943b1059616347c389df809`，commit 日期 2026-09-24。以下為原始碼靜態分析，沒有執行上游程式、登入票務網站或驗證實際購票成功率。

## 結論

保留目前 TypeScript + Playwright，借鏡上游的選票規則、平台分層、流程狀態、冷卻與通知設計。優先完成 Klook 的頁面辨識與一條可觀察的購票流程，再考慮多平台、設定介面或其他瀏覽器引擎。

在本次版本的 src、docs、guide、README 中搜尋不到 Klook，主路由也沒有 Klook 分支。它不能直接提供 Klook 選擇器、商品／方案模型或解決目前 403 的已驗證方法。

## 目前專案的位置

依據 `src/main.ts:1–36` 與 `package.json`：

- 已用 Playwright 啟動可見 Chrome，使用 `./browser-profile` 持久化瀏覽器狀態。
- 用 `WEBDRIVER_EXPERIMENT` 切換單一啟動參數，輸出 navigator.webdriver 作對照。
- 導航到 Klook 首頁，等待 DOMContentLoaded，記錄主文件 HTTP 狀態。
- 403 時保留瀏覽器供人工檢查，不自動重試；其他狀態僅提示檢查頁面。
- 尚未有商品辨識、選日期／方案／張數、頁面狀態機、排程或購票結果判定。
- 有 typecheck 指令；test 仍是預設失敗占位指令。

因此目前最需要的是「能判斷現在在哪一步、為何停住」，再來才是加速。HTTP 200 或 DOMContentLoaded 不代表登入完成、驗證通過或商品選項已就緒。

## 上游如何拆分

| 層 | 原始碼與責任 | 對目前專案的價值 |
|---|---|---|
| 主流程 | `src/nodriver_tixcraft.py`：啟動瀏覽器、定時開始、設定重載、暫停／停止、URL 路由 | 高；借鏡控制流程，不照搬輪詢架構 |
| 平台實作 | `src/platforms/*.py`：各站日期、區域、票種、表單、結帳判斷 | 模組邊界有價值；現有選擇器不適用 Klook |
| 瀏覽器共用層 | `src/nodriver_common.py`：DOM 操作、URL 錯誤分類、通知、暫停與驗證頁處理 | 借鏡責任劃分，Playwright 部分重新實作 |
| 選擇規則與工具 | `src/util.py`：文字正規化、包含／排除、優先順序、排序與 DebugLogger | 最適合先抽象成 TypeScript 純函式 |
| 設定與控制台 | `src/settings.py` + `src/www/`：Tornado 網頁介面、設定、profile、實例狀態、啟停 | 等核心流程穩定後再做 |
| OCR／非瀏覽器輔助 | OCR 模型、`NonBrowser.py`：驗證碼影像及刷新請求等 | 與目前 403 問題不能直接畫上等號，暫不列入移植 |

雖然檔名仍叫 nodriver，主程式實際 `import zendriver as uc`，依賴也使用 zendriver。`NonBrowser.py` 是特定輔助請求的封裝，並不是通用的無瀏覽器購票引擎。

上游的主程式、共用模組、util、settings 與平台 Python 檔合計約 3.4 萬行；是完整應用，並非可直接插入 TypeScript 的小型 SDK。

## 最值得採用的六個設計

### 1. 頁面辨識與平台分層：P0

上游主程式依 URL 導向不同平台，平台內再分派流程。TicketPilot 可分成 `observe → decide → act → verify`：讀取頁面、決定下一步、執行一次、驗證結果。

Klook adapter 應把網站 DOM 轉成共用資料：商品、日期、方案、票種、價格／幣別、張數限制與可用狀態。選票策略不直接操作 DOM。實際欄位和選擇器須以目標商品頁確認，不能從拓元套用。

建議狀態：`opening / needsLogin / needsHuman / waitingForSale / selecting / reviewing / completed / blocked / failed`。URL、頁面文字、可見元素共同判定；SPA 即使 URL 不變也可能換階段。未知狀態應停住並保留診斷。

### 2. 關鍵字優先順序與明確回退：P1

參考 `util.py` 的 `parse_keyword_string_to_array`、`get_matched_blocks_by_keyword`、`get_target_index_by_mode`，以及 `platforms/tixcraft.py` 約 1988–2085 行的區域選擇。

- 依序嘗試偏好群組，命中第一組就從該組候選中選擇。
- 同組字詞採 AND，群組之間是有優先順序的替代條件。
- 支援排除詞，以及正序、倒序、中間、隨機選擇。
- 允許或禁止放寬條件是獨立設定；上游區域分支以 `area_auto_fallback` 控制，缺值時為 false。

建議 TicketPilot 用結構化陣列，避免移植其多種字串輸入格式。例如偏好先「A 區＋一般票」、其次「B 區＋一般票」，排除「視線不良」。價格上限、日期和張數要使用獨立欄位，不只依靠文字包含。

回退仍須遵守價格、日期、幣別和排除條件；預設不接受任意替代方案，也不自動減少張數。候選資料先批次讀取，最後點擊前重新確認目標仍可用。上游拓元區域選擇已批次取得文字，以減少逐元素往返；快取不能當成即時庫存保證。

### 3. 錯誤分類、冷卻與恢復：P0

參考 `nodriver_common.py` 的 `classify_url_error`、`nodriver_current_url`，以及拓元 alert 處理中的 `sold_out_cooldown_until`。冷卻時間戳讓主流程仍可接收停止或暫停。

建議區分：

| 狀態 | TicketPilot 建議反應 |
|---|---|
| 403／明確拒絕 | 記錄頁面與狀態，停止自動動作，人工檢查 |
| 200 但驗證頁／登入頁 | 進入 needsHuman／needsLogin，完成後重新辨識 |
| 429 | 遵守服務端等待資訊，有限次退避 |
| 逾時／暫時性 5xx | 設次數與總時間上限；僅重試可安全重做的讀取／導航 |
| 無符合選項／售完 | 回報原因，依設定等待或停止，不直接視為程式錯誤 |
| 點擊後結果不明 | 先觀察訂單與頁面狀態，不能直接重送 |

這是給目前專案的建議策略，不代表上游已有全平台一致的 retry policy。上游錯誤處理仍散落在平台模組中。

### 4. 開賣等待、暫停與停止：P1

參考 `check_refresh_datetime_gate`、`reload_config`、`check_and_handle_pause`。上游先等到目標時間才分派平台流程，也能修改部分設定而不重啟。

TicketPilot 第一版只需要啟動時驗證設定、明確時區、等待目標時間、取消／暫停與恢復前重新辨識。建議無效日期直接報錯；上游目前無效或空值會解除等待，這個行為不宜照搬。

上游主迴圈每輪先 sleep 0.05 秒，但還會等待其他操作；這不是保證每秒刷新網站 20 次，也不是搶票速度的實測。TicketPilot 不需要直接複製這個間隔。

### 5. 結帳階段與完成狀態分離：P1

上游 TicketPlus 回傳 `purchase_completed`／`is_ticket_assigned`，主流程有停止後續輪詢的 guard；拓元則有進入 checkout 的提示與通知去重旗標。不同平台的完成語意並不完全一致。

TicketPilot 應區分「已選票」「待確認」「已建立訂單」「已付款」。看到 checkout URL 不能直接當成已付款。到達預設交接階段後停止自動動作並通知一次；不可在結果不明時重複點擊提交。

### 6. 可觀察性：P0

借鏡 DebugLogger 與分階段通知，增加結構化事件：時間、流程狀態、頁面類型、動作、耗時、重試數與錯誤分類。失敗或進入未知狀態才保存截圖及必要診斷，避免每輪輸出大量重複訊息。

日誌應遮蔽 cookie、token、個資與 URL 中敏感參數。先使用終端訊息或本機提示；Discord／Telegram 是上游已有的可選能力，並非目前必需。

## 不宜直接移植的部分

- **切換成 Python／zendriver**：增加另一套 runtime，尚無 Klook 相容性或 403 改善證據。
- **整套驗證碼與 Cloudflare 處理**：其存在不代表適用 Klook，應先確認目前收到的是什麼頁面。先做好辨識與人工接手。
- **所有平台與巨大的 util 模組**：平台差異很多，函式也混有不同世代的格式和 API。移植行為規格比逐行翻譯更適合目前專案。
- **多實例控制與完整 Web UI**：目前單一 Klook 流程尚未完成，提早做會放大 session 與設定管理成本。
- **測試指南當成已有測試的證據**：文件描述了 tests/unit、integration 等，但本次 commit 的 tracked files 沒有該測試樹、requirements-dev.txt 或 pyproject.toml；有另行存在的 OCR smoke test。不能据此假設完整測試套件可執行。
- **直接複製程式碼而忽略來源**：上游 LICENSE 是 GPL-3.0，README 另有使用限制描述；本地 package.json 是 ISC。若未來要引入實際程式碼，需另行確認授權安排。這份文件沒有移入上游實作。

## 建議實作順序與驗收

| 階段 | 交付內容 | 驗收重點 |
|---|---|---|
| P0：能診斷 | Klook 頁面分類、狀態記錄、失敗截圖、暫停／停止 | 能分辨拒絕、人工驗證、登入、正常商品頁、未知頁；遇到問題不空轉 |
| P1：能正確選擇 | 設定檔、候選資料模型、偏好與排除策略 | 用離線資料驗證優先順序、無符合條件、售完、價格限制、張數不足與回退行為 |
| P1：單一流程 | 目標商品的日期／方案／張數與下一步驗證 | 每個動作都確認結果，到 review 階段停止；頁面變化時可診斷 |
| P2：穩定使用 | 開賣等待、有限次退避、去重通知、設定調整 | 時區明確、可中止、不重複提交、不把結帳頁當成付款完成 |
| P3：擴充 | 第二個平台、設定 UI、按需要評估替代引擎 | 以實際需求決定，而非一次搬入全部上游功能 |

最小目錄建議：`src/main.ts` 負責組裝；`src/browser.ts` 管理 Chrome 生命週期；`src/config.ts` 驗證設定；`src/flow.ts` 管理狀態與恢復；`src/platforms/klook.ts` 辨識／操作頁面；`src/selection.ts` 處理純選擇策略；`src/diagnostics.ts` 記錄事件與失敗證據。這是建議，尚未建立這些程式模組。

目前缺少目標 Klook 商品 URL、希望的日期／方案／票數與預計自動化終點，所以還不能確認具體 selector 或端到端可行性。這不影響先完成 P0 的共用診斷。

## 固定版本來源

- [主迴圈、定時開始、設定重載與平台路由](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/nodriver_tixcraft.py)
- [瀏覽器共用工具、錯誤分類與通知](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/nodriver_common.py)
- [文字與選擇規則](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/util.py)
- [拓元平台實作](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/platforms/tixcraft.py)
- [TicketPlus 平台實作](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/platforms/ticketplus.py)
- [設定服務與預設值](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/src/settings.py)
- [測試文件](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/docs/02-development/testing_execution_guide.md)
- [LICENSE](https://github.com/bouob/tickets_hunter/blob/9e2d1061b48706076943b1059616347c389df809/LICENSE)
