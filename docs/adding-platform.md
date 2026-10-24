# 新增購票平台

這份指南說明如何把新平台接入設定、執行管理、購票程序與 GUI。正式入口目前只有 TicketPlus；測試中的假平台不是可執行的購票平台。Klook 已封存，不得透過登記處重新啟用。


## 模組責任與依賴

- `src/config/`：解析活動設定。不要引用執行管理、worker 或瀏覽器。
- `src/app/platforms/`：提供啟動驗證、指紋內容、事件與結果規則。不要載入 Playwright 或引用 `src/local/` 的實作。
- `src/app/run<Platform>.ts`：協調平台流程與瀏覽器、驗證 lease 並管理釋放時機。
- `src/platforms/<platform>/`：依觀察到的 DOM 實作網站操作、選票與平台恢復流程。
- `src/local/`：管理請求去重、子程序、執行紀錄及控制訊息；平台 worker 將詳細結果轉成可保存的摘要。
- `src/shared/`：前後端可共同引用的資料型別，不含 Node 或瀏覽器啟動的 runtime 依賴。
- `src/local/react/platforms/<platform>/`：平台表單、工作區、流程文字和步驟呈現。

後端依賴方向為 `local → app → config`。前端可以引用安全的設定解析與 shared 型別；不要讓前端載入檔案系統、子程序或 Playwright。

## 四個接入範圍

| 範圍 | 登記位置 | 平台提供的內容 |
| --- | --- | --- |
| 設定 | `src/config/settingsRegistry.ts` | 平台 ID 與設定解析器 |
| 執行規則 | `src/app/platforms/index.ts` | `PlatformDefinition` |
| worker | `src/local/workerEntries.ts` | 設定解析器與 worker 執行函式 |
| 前端 | `workspaceRegistry.ts` 與 `runPresenterRegistry.ts` | 工作區元件及純狀態呈現函式 |

前端刻意分成兩份 runtime 清單。工作區會使用 `RunStatus`，而 `RunStatus` 會查找 presenter；如果 presenter 清單又載入工作區，就會形成循環。不要把兩份清單合成會互相載入的模組。

登記處不會自動擴充 TypeScript 型別。新增真實平台時，仍須明確擴充下面的聯集和驗證：

- `config/platforms.ts` 的 `platformIds`。
- `config/activitySettings.ts` 的 `ActivitySettings`。
- `shared/runEvents.ts` 的新 worker 事件聯集；不要把新事件放入 `HistoricalRunEvent`。
- 若新平台有不同流程、結果或停止原因，檢查 `shared/runSnapshot.ts`、`shared/runControls.ts`、`app/platforms/platformDefinition.ts`、`local/workerProtocol.ts` 及 `local/runRecord.ts` 的型別與驗證。

目前的流程類型仍是 `purchase | lottery`，交接結果仍包含 `information-ready`、`payment-ready`、`registration-ready`。新平台若無法用現有約定表達，應明確擴充介面、驗證、畫面和測試；不要用型別斷言繞過檢查，也不要把不同意思的狀態硬套成現有名稱。

## 1. 設定解析

新增平台設定型別與 `parse<Platform>Activity(unknown)`，再登記到 `parsePlatformSettings`。

解析器必須：

- 驗證平台 ID、活動網址與平台必要欄位。
- 只回傳已確認的設定，拒絕不完整或不支援的格式。
- 保持儲存、載入與 API 比對的序列化結果一致，包括預設值與欄位順序。

`ActivityStore` 的讀取及儲存入口已使用共用解析。不要再另外加入一條只供載入或只供啟動的解析路徑。`parseActivity` 會先拒絕封存 Klook 設定；新平台不能改變這項行為。

## 2. 平台執行規則

在 `src/app/platforms/` 建立平台定義，參考 `ticketPlus.ts`，並登記到 `executionPlatform`。

`PlatformDefinition` 提供：

- `id`、`name`、可讀取的 `recordVersions`。
- `bind(settings)`：解析並綁定設定後，提供指紋內容、可比對的版本、啟動驗證、排程驗證及快照補充欄位。
- `parseEvent`、`acceptsResult`、`stopReason`：驗證平台新事件與結果。
- `waitingForSale`：將平台階段解讀為活動執行狀態。
- 選填 `stop` 和 `participants`：聲明操作訊息與等待中的確認 ID。

平台提供指紋「內容」，共用執行管理負責雜湊。版本以平台及版本共同辨識；TicketPlus 的既有版本與雜湊不能因新增平台而改變。重複 request ID 的判斷仍先於新的啟動限制，不能把舊請求當新請求重新執行。

平台只提供 `PlatformSnapshotFields` 明列的補充欄位。目前包括活動名稱、開賣時間與流程類型。共用層逐欄取值；不要展開平台物件覆寫 `requestId`、`id`、`status`、`occupied` 或操作資格。

## 3. 購票流程與 worker

新增平台網站操作、app runner 與 local worker，再透過 `createWorkerEntry(id, parse, run)` 登記到 `workerEntries.ts`。

worker 接收：

- `WorkerInput`：活動設定與 `lease`。
- `WorkerEnvironment`：`onBrowser`、`sendEvent`、`onSubmitAttempt`、停止 `signal`，以及選填的 `waitForParticipants`。

worker 應回傳 `WorkerResult`，不要把頁面 HTML、參加者身分資料或其他私人資料放入事件與結果。

### 提交與控制訊息

`onSubmitAttempt()` 必須在嘗試提交之前同步呼叫，不能等點擊成功後才呼叫，也不能排進背景工作。共用 worker 依此判斷例外是否屬於提交結果不明；不明結果不能自動重送。

`purchaseWorker.ts` 在第一個非同步等待之前註冊停止、參加者確認及關閉瀏覽器的接收器，並保留 `settled` 檢查。平台透過 `signal` 接收停止，不自行新增 IPC 接收器。新增平台不可先等待載入或開啟瀏覽器，再準備接收停止要求。

操作有兩層判斷：平台是否提供能力，以及本輪現在能否接受。共用層保留同輪一次性控制、確認 ID 核對與停止後禁止確認；平台不能以「支援這個功能」略過目前資格。

### Lease 的責任仍在 runner

共用層提供去重、持續占用鎖和 lease 工具，但不替每個平台 runner 自動完成釋放。

平台 runner 必須驗證收到的 lease，並保證流程與瀏覽器都結束後才釋放。外層 worker 不能再新增第二個釋放者。參考 `runTicketPlus.ts` 的處理，測試流程先結束、瀏覽器先關閉、啟動前停止與父服務失聯的情況。

關閉 GUI 工作區、隱藏活動或封存紀錄都不能釋放 lease。程序失聯或提交結果不明，也不能自行重新啟動購票。

## 4. GUI 工作區

建立符合 `WorkspaceProps` 的工作區，登記到 `registeredWorkspaces`。目前只有一個正式平台時，App 仍直接顯示該工作區；有多個平台才顯示選擇按鈕。

工作區應：

- 使用 App 提供的 `runs`，不要重新呼叫 `useRunStatus` 建立另一份全域訂閱或操作鎖。
- 透過 `registerLeaveGuard` 註冊離開檢查並在卸載時清理；使用 `useLayoutEffect` 或等效方式，避免使用舊草稿狀態。
- 保存或啟動中用同步 ref 擋住離開，未儲存草稿須取得使用者同意後才離開。
- 尊重 `navigationBusy`，在共用 pending 核對期間禁止其他變更及導覽。
- 在 pending 改變後呼叫 `onPendingChange`。
- `managesPendingStart` 為 true 時，不重複顯示平台自己的 pending 按鈕；由 App 的共用入口核對。

App 切換平台會先檢查 pending、關窗與離開 guard。工作區卸載不會清除全域執行狀態，也不能繞過占用限制。

### 待確認的開始請求

新平台使用 `shared/runs/pendingStart.ts`，不要自行建立另一個互不相通的 pending key。

- 新 key：`ticketpilot-platform-purchase-request`，version 2，包含平台、request ID、活動 ID 與設定 signature。
- 舊 TicketPlus key：`ticketpilot-ticketplus-purchase-request`，version 1，仍可讀；不自動改寫原文或 signature。
- 舊 Klook key：`ticketpilot-purchase-request`，不讀取、不覆寫。

新舊 key 衝突、資料損壞或結果查不到時，都保留紀錄並阻止新請求。新平台開始前須檢查 pending，不能先儲存新設定再發現另一筆結果未明。

只有明確接受並核對原 request ID／平台，或後端明確表示未接受，才可清除。`clearPendingStart` 會檢查原文及來源 key，晚回應不能刪掉已替換或新出現的衝突紀錄。

## 狀態呈現與 GUI 操作控制

在平台目錄提供 `RunPresenter`，登記到 `runPresenterRegistry.ts`：

- `status(run, closing, now)`：標題與提示。
- 選填 `steps`：共用 `RunStepsView`。
- `eventMessage`：只解讀本平台事件。

presenter 只產生顯示資料，不載入工作區元件，不發送操作。平台步驟可以呼叫平台自己的狀態 helper，但不能反向呼叫會分派回自己的共用 presenter。

TicketPlus presenter 保留終局與停止進度的優先順序；新 presenter 也必須處理這些狀態。共用畫面保留歷史事件的回退顯示。新平台應測試自己獨有的階段，確認共用元件不需要加入平台名稱判斷。

GUI 操作控制約定：`capabilities` 表示平台能力；`canStop`、確認 ID 等表示目前資格。停止要求送出後，即使按鈕停用，仍要顯示「傳送中／已送出／未確認」。回應須核對本輪 ID 與平台，並以版本防護避免晚回應覆蓋新的 SSE 狀態。共用前端限制不能取代後端驗證。

## 歷史紀錄與相容性

`local/runRecord.ts` 與新事件驗證分開。歷史紀錄保留原本允許的欄位與事件範圍，不直接套用新 worker 的嚴格訊息格式。

- 先驗證格式、版本與平台組合，再判定 Klook 封存；不能看到 Klook 就略過合法性檢查。
- 平台歷史版本由各自的 `recordVersions` 提供；不同平台可以使用相同版本數字，但不能因此視為同一種格式或接受其他平台事件。
- 磁碟上的 `capabilities`、`canStop`、確認 ID、關窗資格及停止要求不能直接授權新操作；讀取時移除舊資格，由目前服務產生。
- 舊 request ID 與持續鎖仍有效，不得因紀錄被隱藏、格式升級或平台封存而重用。
- 新平台若增加流程或結果型別，必須同步修改歷史驗證器；不能只讓新 worker 回傳而忽略後續重啟讀取。

## 測試與驗證

每個真實平台至少需要下面幾類測試：

1. 設定解析與序列化：錯誤網址、缺值、未知平台、存檔重讀與前後端比對一致。
2. 執行規則：設定指紋、歷史版本、重複請求、排程限制及平台事件隔離。
3. worker：lease 驗證、停止接收時機、提交前通知、例外分類、未知訊息拒絕與不重送。
4. 網站流程：用本機 fixture 或攔截 route 驗證匹配、模糊 selector、逾時、恢復邊界及不應發生的點擊。
5. GUI：dirty／busy 離開檢查、跨平台 pending、占用狀態、操作能力、晚回應與歷史顯示。

可參考：`platformSettings.test.ts`、`platformRegistry.test.ts`、`workerRegistry.test.ts`、`pendingStart.test.ts`、`platformWorkspaces.gui.test.ts`、`runPresenterRegistry.test.ts`、`runEligibility.test.ts`、`runCloseOrdering.test.ts`、`runParticipantsOrdering.test.ts` 及 TicketPlus 的實際流程測試。

假平台只用於測試登記處或透過 `App({ workspaces })` 注入。`tests/fixtures/platformWorkspaces.tsx` 使用真 React App 與本機 Vite，驗證平台切換；不得把假平台登記到正式清單，也不得加入可在正式 GUI 啟用它的選項。

從 repository root 執行：

```sh
npm run typecheck
npm run build:gui
node --import tsx --test tests/platformRegistry.test.ts
node --import tsx --test --test-concurrency=4 --test-timeout=60000 tests/*.test.ts
npm run format
```

依改動範圍先跑相關檢查，再完成需要的整體測試。程式修改須經獨立子代理審查，確認問題修正後重跑相關檢查，才提交當次工作。GUI 與平台流程測試使用本機頁面，不代表已驗證真實售票網站；真實 DOM 尚未確認的地方必須明列。
