# 測試指南

先按「要保護的規則」找測試，再選擇需要的層。檔案數和 coverage 只用來輔助盤點；重要規則還要確認「刻意改壞時，測試真的會失敗」。

## 分類與執行

| 目錄 | 責任 | 例子 |
| --- | --- | --- |
| `unit/` | 不開瀏覽器的規則與資料轉換 | 開賣時間、執行資格、送出結果分類 |
| `architecture/` | 模組依賴與入口限制 | 禁止主服務載入瀏覽器模組 |
| `integration/` | 服務、儲存、子程序之間的合作 | API、購票鎖、worker 回報 |
| `browser/ticketplus/` | 在假頁面讀資料及操作 | 場次、張數、彈窗、刷新 |
| `browser/gui/` | 自己 GUI 的互動與排版條件 | 啟動、表格捲動、平台切換 |
| `flow/ticketplus/` | 在假 TicketPlus 頁面串起購票流程 | 多輪順位、提交、期限與停止 |
| `flow/application/` | 串起應用程式的 API、worker 或 GUI | 啟動、停止、抽選確認 |
| `tooling/` | 測試工具本身 | 遞迴找檔案、私人資料標記比對 |
| `fixtures/` | 共用假頁面、資料與資源清理 | 每個場次有自己的目的頁 |
| `visual/` | 固定環境的截圖比對試點，單獨執行 | 平台首頁 |

`flow` 使用本機服務與假網站，不代表已在 TicketPlus 實站驗證。單純的排版檢查放在 `browser/gui`，避免混進啟動流程。

先執行 `npm ci`、`npx playwright install chromium`。以下指令從專案根目錄執行：

```sh
npm run typecheck
npm test
npm run test:list
npm test -- unit
npm test -- integration
npm test -- browser
npm test -- flow
npm test -- architecture
npm test -- tooling
npm run test:gui
```

`npm test` 先建置 GUI，再遞迴執行所有 `.test.ts`，同時最多跑 4 個檔案。空分組和未知分組會失敗，不會顯示「零個測試通過」。

`test:gui` 包含 GUI 單元測試、GUI 瀏覽器測試、應用流程，以及原本 GUI 指令涵蓋的執行資格等測試。它比原先逐一列檔名的範圍更廣，也包含應用流程的 API／worker 測試。

傳入 Node 測試選項時，先指定分組：

```sh
npm test -- all --test-name-pattern="場次"
node scripts/runTests.mjs browser --list
```

搬檔案時，先保存 `test:list` 與實際執行的測試名稱，搬完後按新舊路徑對照，確認沒有漏掉或重複。檢查 `import.meta.url`、`new URL`、worker 入口與資源目錄；型別檢查無法保證字串算出的路徑正確。

## 哪些錯誤由哪一層保護

| 重要規則 | 主要測試 |
| --- | --- |
| 不點錯場次；假頁面不能把每個按鈕都導到同一場次 | `browser/ticketplus/ticketPlusSessionName.test.ts`、`sessionNavigationFixture.test.ts`；應用流程使用同一個 fixture 導頁處理器 |
| 不接受無效順位起點或期限，也不留下操作 | `browser/ticketplus/ticketPlusPriority.test.ts` |
| 開賣時間格式完整，提前刷新只接受 1／2 秒 | `unit/config/saleSchedule.test.ts` |
| 座位不符必須停止；期限停止和使用者停止不能混淆 | `unit/runs/submissionOutcome.test.ts`、`ticketPlusDeadlineOutcome.test.ts` |
| 舊執行者不能釋放別人的購票鎖 | `integration/storage/purchaseLock.test.ts` |
| 日誌不含已知的私人測試資料 | `flow/ticketplus/ticketPlusRunner.test.ts`、應用登入測試及 `tooling/privateMarkers.test.ts` |

私人資料檢查使用完整的假資料標記，避免 `elapsedMs: 10987` 被誤認為手機資料。這只保護已知 fixture 標記，不是通用的個資掃描器。

## 怎麼確認測試有用

在不含私人資料的臨時複本做實驗：先跑原版，刻意改壞一處，再跑相同測試，最後還原重跑。失敗必須由相關斷言觸發；語法錯誤或環境啟動失敗不算抓到業務錯誤。

本輪已完成的局部實驗：

| 刻意改壞的地方 | 結果 |
| --- | --- |
| 所有場次按鈕都導到 B 場次 | fixture 導頁測試失敗 |
| 允許不同 token 釋放購票鎖 | 既有購票鎖測試失敗 |
| 拿掉鎖檔最外層的結構檢查 | 仍通過；程式仍有後續欄位檢查與錯誤處理，本輪不宣稱已補強這一處，也不為分數硬補測試 |
| 拿掉座位不符的停止分類 | 新增的結果分類測試失敗 |
| 把期限停止改成使用者停止 | 新增的停止原因測試失敗 |
| 拿掉順位起點範圍或期限上限 | 新增的輸入檢查測試失敗 |
| 讓提前刷新接受 3 秒 | 開賣設定測試失敗 |

這些結果來自各項相關測試，不是全專案的 mutation 分數。每次實驗還原後，相關測試都再次通過。新增或修改重要規則時，沿用這種方法，不必每次對所有模組全面改壞。

## 截圖試點

```sh
npm run test:visual
```

仍使用 `node:test`，以 Playwright 截圖，再用 pixelmatch 比較。只測平台首頁；一般 `npm test` 不執行 `.visual.ts`。試點另外把背景改成紅色，確認圖片比較會發現差異。

目前基準只在建立它的同一台電腦使用。`visual/baselines/platformHome.json` 記錄系統、Chromium、視窗大小等條件。環境不同會失敗；相同 metadata 也不保證不同電腦的字型一致。尚未建立共用 CI 截圖環境。

結果放在忽略版控的 `test-results/visual/`，包括 `actual.png`、`diff.png` 和 `mutation-diff.png`。先看差異，確認是預期的畫面修改，再更新基準：

```sh
UPDATE_VISUAL_BASELINE=1 npm run test:visual
```

更新後要人工看圖，並在不設定更新變數的情況下重跑。不要為了讓測試通過而自動接受新圖。字型、系統或瀏覽器升級也可能需要人工重建基準。

## 保留的缺口

- 假頁面適合穩定重現錯誤、超時與禁止點擊的情況，仍需保留。
- 現有頁面樣本包含依觀察重建的內容，不能視為可靠的原始實站錄製。本輪沒有新增實站錄製層。
- 後續取得有來源、日期、狀態說明且已去除私人資料的頁面資料後，才能做回放試點。靜態 HTML 本身不能重現所有載入、轉頁及網路行為。
- 截圖只能發現畫面差異，需要人判斷差異是否正確；首頁試點不代表其他畫面都已受保護。
- Node coverage 無法完整呈現 `page.evaluate` 內的瀏覽器程式與 React 畫面，不用它證明這些功能已測好。

## 本輪驗收紀錄（2026-10-26）

- 搬移前實際執行 633 個測試；搬移後 641 個全數通過，沒有跳過，耗時約 125 秒。逐項比對名稱，原本 633 個都保留，新增 8 個。
- 搬移前有一個開賣刷新間隔測試失敗，單獨重跑通過；最後全套也通過。保留這項時間敏感風險，不把第一次結果寫成全數通過。
- 型別檢查通過；截圖試點另執行 1 個測試並通過。
- 已做獨立審查與前述局部改壞實驗。這些驗證都在本機假頁面或臨時資料上完成，沒有實站購票驗證。
