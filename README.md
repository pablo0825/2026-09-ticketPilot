# TicketPilot

使用 TypeScript 與 Playwright 操作 Klook 購票流程的本機工具。可透過網頁介面設定活動、票區順位、張數與開賣時間，也可使用命令列啟動。

工具會依設定選票、核對座位與訂單摘要、填寫並提交聯絡資料，確認到達付款頁且金額正確後停止。**付款須自行完成；到達付款頁不代表已完成購票。**

目前支援已實作的 Klook 繁體中文活動頁流程，並非所有活動通用。網站結構或流程不同時可能停止，也不保證取得票券。

## 第一次安裝

### 1. 準備執行環境

- 安裝 **Node.js 24 LTS** 與隨附的 npm，依下方方式操作。已安裝 24.x 的使用者可略過安裝。
- 安裝 Google Chrome。實際購票會啟動電腦上安裝的 Chrome。
- 準備可手動登入的 Klook 帳號。

#### 安裝 Node.js

可以直接點選官方安裝檔，或複製下方對應系統的指令到終端機。兩種方式擇一即可。

| 系統 | 官方安裝檔 |
| --- | --- |
| macOS（Apple Silicon／Intel） | [下載 .pkg](https://nodejs.org/download/release/v24.21.0/node-v24.21.0.pkg) |
| Windows（Intel／AMD 64 位元） | [下載 x64 .msi](https://nodejs.org/download/release/v24.21.0/node-v24.21.0-x64.msi) |
| Windows（ARM64，例如 Snapdragon） | [下載 ARM64 .msi](https://nodejs.org/download/release/v24.21.0/node-v24.21.0-arm64.msi) |

以下固定使用 `24.21.0`，是 2026-10-09 查核時官方提供的 Node.js 24 LTS 版本。之後可在 [Node.js 官方下載頁](https://nodejs.org/en/download) 選擇 24.x 的更新版本。本專案目前本機使用 `24.4.1`，尚未完成 `24.21.0` 或其他主版本的相容性驗證。

**macOS：** 開啟「終端機」，貼上整段指令：

```bash
ticketpilot_node_pkg="$(mktemp -d)/node-v24.21.0.pkg"
curl --fail --location "https://nodejs.org/download/release/v24.21.0/node-v24.21.0.pkg" --output "$ticketpilot_node_pkg" && open "$ticketpilot_node_pkg"
```

**Windows：** 開啟 PowerShell，貼上整段指令。以下適用 Intel／AMD 64 位元電腦；ARM64 電腦請改用表格中的 ARM64 安裝檔。

```powershell
$ticketpilotNodeMsi = Join-Path ([System.IO.Path]::GetTempPath()) ("node-v24.21.0-" + [guid]::NewGuid().ToString() + ".msi")
Invoke-WebRequest -Uri "https://nodejs.org/download/release/v24.21.0/node-v24.21.0-x64.msi" -OutFile $ticketpilotNodeMsi -ErrorAction Stop
Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$ticketpilotNodeMsi`"") -Wait
```

指令會從 Node.js 官方網站下載並開啟安裝程式，**仍需依安裝視窗完成操作**，可能要求管理員權限。保留預設的 npm 與 PATH 選項即可。

安裝完成後，關閉並重新開啟終端機，確認指令可用：

```bash
node --version
npm --version
```

若找不到指令，先關閉並重新開啟終端機，再確認 Node.js 已完成安裝。

Windows PowerShell 若顯示 `npm.ps1` 無法執行，本文的 `npm` 指令可改用 `npm.cmd`，例如 `npm.cmd --version`、`npm.cmd ci` 與 `npm.cmd run gui`。

### 2. 下載並解壓縮專案

在 GitHub 專案頁按 **Code → Download ZIP**，下載後解壓縮。使用 ZIP 不需要安裝 Git。

在終端機切換到解壓縮後的專案資料夾，也就是能看到 `package.json` 的位置：

```bash
cd "你的專案資料夾路徑"
```

請把引號內文字換成實際路徑。後續所有指令都在這個資料夾執行。

### 3. 安裝依賴

```bash
npm ci
```

這會依照 `package-lock.json` 安裝依賴到 `node_modules/`。第一次下載或換到新的專案資料夾時需要執行；平常每次啟動不用重裝。

一般使用工具只需已安裝的 Google Chrome。`npx playwright install chromium` 是執行本機瀏覽器測試時使用，不能取代購票所需的 Chrome。

## 使用網頁介面

### 1. 開啟工具

```bash
npm run gui
```

指令會先編譯介面，再啟動本機服務並開啟網頁。請保留終端機視窗。

若網頁沒有自動開啟，複製終端機顯示的 `http://127.0.0.1:連接埠` 網址到瀏覽器。連接埠由程式分配，每次啟動可能不同。也可只啟動服務、自行開啟網址：

```bash
npm run gui -- --no-open
```

### 2. 設定活動與購票順位

在首頁按「新增活動」，或從已儲存的清單按「使用活動」。

填寫官網完整活動名稱與 Klook 繁體中文活動網址，網址格式為 `https://www.klook.com/zh-TW/event-detail/活動識別字/`。接著新增並調整購票順位：

| 欄位 | 填寫內容 |
| --- | --- |
| 日期、時間 | 演出場次，例如 `2026-11-02`、`19:30`；不是開賣時間 |
| 票種／票區 | 官網顯示的目標票種或票區文字 |
| 單價 | 每張票的新台幣價格 |
| 張數 | 要購買的張數，須為正整數 |
| 連位 | 多張票可勾選；單張不適用 |

上方順位優先。只有明確失敗且能安全繼續時，才會嘗試下一順位；不會反覆循環清單。模式固定為 `STRICT`，不購買清單以外的票種。

預設排除「愛心席」「身障」「視線不良」，可依需求修改。目標票區若符合排除詞，必須先修正設定才能開始。

介面的預期總價為「單價 × 張數」。若頁面金額不同或包含未支援的額外費用，核對會停止。連位目前核對網站的連位選項，尚未獨立驗證座位號碼是否相鄰。

第一步按「下一步」會儲存活動；日後可以從首頁再次載入。

### 3. 儲存聯絡資料

填入名字、姓氏、電話區碼、手機號碼與 Email，並按儲存。修改資料後也要再次儲存。

- 名字與姓氏分別填寫。
- 手機欄位接受 6–15 位數字，區碼另行選擇，不加入空格或連字號。
- Email 必須符合電子信箱格式。

網頁介面會建立專案根目錄的 `contact.local.json`，不需要自行複製範本。所有活動共用這份聯絡資料；資料缺少或格式錯誤時，不會開始購票。

### 4. 確認並開始

核對購票摘要，選擇「立即開始」，或指定台灣時間（UTC+08:00）的開賣時間，並選擇提前 1 或 2 秒刷新。

**按下「開始購票」會執行真實購票流程，包含座位確認與聯絡資料提交。** 請先確認活動、場次、票區、張數、金額與聯絡資料。

工具會另外開啟購票用 Chrome。若顯示「請手動登入」，請在該視窗完成 Klook 登入；工具不代填帳密或驗證碼。首次登入後，登入狀態會保存在本專案的 `browser-profile/`，與平常使用的 Chrome 設定檔分開。

一般人工登入等待上限為五分鐘。指定開賣時間時，啟動與等待開賣階段另受「開賣後兩分鐘」截止限制。請提前啟動並完成登入，保持電腦喚醒及系統時間正確。

開始後會切換到執行狀態頁，可以查看進度與複製日誌。修改設定不會改變已啟動的那次流程。

### 5. 檢查結果與關閉

- **已到付款頁**：工具已核對付款頁與金額，請在購票 Chrome 自行檢查並完成付款。
- **購票已停止**：閱讀停止原因並檢查瀏覽器。資料不符、未知提示或逾時不等於售罄。
- **提交結果不明／程序中斷**：先人工確認頁面與 Klook 訂單，不要直接重啟購票或重複提交。

流程結束後，先完成必要的訂單檢查或付款，再使用狀態頁的「關閉購票瀏覽器」（若有顯示），或手動關閉購票 Chrome。這個按鈕不會取消訂單。

等購票瀏覽器與購票程序結束後，回到終端機按 `Ctrl+C` 關閉本機服務。購票子程序仍執行時，服務會拒絕關閉並提示先關閉購票瀏覽器。目前沒有執行中的 GUI 停止按鈕。

同一份專案一次只能使用一個購票瀏覽器，GUI 與命令列也不能同時購票。到達付款頁但尚未關閉瀏覽器時，仍會占用。

## 使用命令列

如果使用上面的網頁介面，可略過本節。

1. 在專案根目錄複製 `contact.example.json`，將副本命名為 `contact.local.json`，填入自己的資料。`firstName` 是名字、`lastName` 是姓氏；`regionLabel` 使用網站完整選項文字，例如 `台灣 (+886)`。原範本的空白值不能直接使用。
2. 編輯 [`src/config/event.config.ts`](src/config/event.config.ts)，確認活動網址、每個順位的日期、時間、票區、張數、連位要求，以及 `expectation` 中的活動名稱、單價和總價。檔案內既有活動設定只是目前設定，執行前務必換成自己的目標。
3. 在專案根目錄執行：

```bash
npm start
```

`targets` 陣列順序就是購票順位。保留 `fallbackMode: "STRICT"`，並確認 `excludeKeywords` 符合需求。需要定時開始時，可依設定檔註解加入 `saleSchedule`；詳細格式見 [開賣時間設定](docs/sale-schedule.md)。

**`npm start` 只讀取 `src/config/event.config.ts` 與 `contact.local.json`，不會使用 GUI 選中的活動。** 啟動後同樣需要手動登入，並在付款前停止。

## 用 ZIP 更新版本

1. 完成訂單檢查，關閉購票 Chrome 與舊版服務。
2. 備份自己的 `contact.local.json`、`local-data/` 與 `browser-profile/`。若使用命令列，也記下自己修改的活動設定。
3. 將新版 ZIP 解壓縮到新資料夾，執行 `npm ci`。
4. 需要沿用設定時，將備份的本機資料複製到新版資料夾。命令列活動設定請對照新版格式重新填入。
5. 執行 `npm run gui`，使用這次終端機顯示的新網址，重新確認設定後再開始。

請勿同時啟動新舊兩份專案購票。若備份內有殘留的 `purchase.lock`，先依下方說明確認狀態，不要直接刪檔重跑。

## 常見問題

### 找不到 package.json，或 npm ci 失敗

確認 ZIP 已解壓縮，且終端機位於含有 `package.json` 與 `package-lock.json` 的專案根目錄。安裝依賴需要網路；若仍失敗，保留 npm 的完整錯誤訊息供排查。

### 找不到 Chrome

確認電腦已安裝 Google Chrome。真實購票使用 Playwright 的 `chrome` channel，只有測試用 Chromium 不足以啟動購票流程。

### 聯絡資料缺少或格式錯誤

GUI 使用者回到第二步修正並儲存。命令列使用者檢查 `contact.local.json` 是否存在、JSON 是否有效，以及必要欄位是否已填寫。

### 顯示購票瀏覽器仍被占用

先關閉原購票瀏覽器並等待程序結束。若曾強制終止或重開電腦，可能留下 `local-data/purchase.lock`。

請先檢查 Klook 訂單、關閉原購票 Chrome，並確認舊 GUI、CLI 與 worker 程序均已停止。**只有確認沒有未處理訂單或仍在提交的程序後，才可人工移除占用檔並重新啟動。** 不要刪除執行紀錄來重送請求。

### 選票停止，或所有順位都未取得票

依執行紀錄判斷原因。工具只處理已辨識的失敗與過期提示；未知狀態會停止，不會猜測按鈕或無限刷新。座位確認與聯絡資料提交不會自動重送。

## 本機資料與分享

| 路徑 | 用途 |
| --- | --- |
| `contact.local.json` | 所有活動共用的聯絡資料 |
| `browser-profile/` | 購票 Chrome 的登入狀態與瀏覽器資料 |
| `local-data/events/` | GUI 儲存的活動設定 |
| `local-data/runs/` | 執行狀態與紀錄 |
| `local-data/purchase.lock` | 購票瀏覽器占用紀錄 |
| `diagnostics/` | 選票失敗時可取得的本機診斷資料 |

這些路徑已列入 `.gitignore`。分享專案時不要附上自己的聯絡資料、登入資料或本機紀錄；手動壓縮整個資料夾不會自動套用 `.gitignore`。聯絡資料會在購票時填入並提交給 Klook。

GUI 只監聽本機 `127.0.0.1`，目前不提供遠端部署或多人帳號功能。

## 開發與驗證

需要執行測試時，先安裝測試用 Chromium：

```bash
npx playwright install chromium
npm run typecheck
npm test
```

測試使用本機 fixtures 或攔截路由，不代表已通過真實網站的完整購票驗證。

| 指令 | 用途 |
| --- | --- |
| `npm ci` | 安裝鎖定版本的依賴 |
| `npm run gui` | 編譯並啟動本機網頁介面 |
| `npm start` | 使用程式設定檔啟動真實購票 |
| `npm run build:gui` | 編譯 GUI 前端到 `dist/gui/` |
| `npm run typecheck` | 檢查 Node 與前端 TypeScript 型別 |
| `npm test` | 先編譯 GUI，再執行測試 |
| `npm run format` | 使用 Prettier 格式化專案 |
| `npm run format:check` | 檢查格式，不修改檔案 |

更多操作與限制請參閱 [GUI 使用說明](docs/gui-usage.md)、[登入流程](docs/login-startup.md)、[開賣時間設定](docs/sale-schedule.md)及[流程暫停測試](docs/flow-pause-testing.md)。
