# TicketPilot

透過本機網頁介面設定並執行 TicketPlus 購票或登記抽選。購票停在付款頁，抽選停在最終確認登記之前；付款與最終登記由你自行完成，金額也請自行核對。

## 1. 準備環境

先安裝 **Node.js 24 LTS**（內含 npm）與 **Google Chrome**，並準備 TicketPlus 帳號。已安裝的使用者可略過。

Node.js 官方安裝檔（24.21.0）：

- [macOS（Apple Silicon／Intel）](https://nodejs.org/download/release/v24.21.0/node-v24.21.0.pkg)
- [Windows（Intel／AMD 64 位元）](https://nodejs.org/download/release/v24.21.0/node-v24.21.0-x64.msi)
- [Windows（ARM64）](https://nodejs.org/download/release/v24.21.0/node-v24.21.0-arm64.msi)

下載後開啟安裝檔，依畫面完成安裝。也可展開下方指令，從終端機下載並開啟安裝程式。

<details>
<summary>使用終端機安裝 Node.js</summary>

**macOS 終端機：**

```bash
ticketpilot_node_pkg="$(mktemp -d)/node-v24.21.0.pkg"
curl --fail --location "https://nodejs.org/download/release/v24.21.0/node-v24.21.0.pkg" --output "$ticketpilot_node_pkg" && open "$ticketpilot_node_pkg"
```

**Windows PowerShell（Intel／AMD 64 位元）：**

```powershell
$ticketpilotNodeMsi = Join-Path ([System.IO.Path]::GetTempPath()) ("node-v24.21.0-" + [guid]::NewGuid().ToString() + ".msi")
Invoke-WebRequest -Uri "https://nodejs.org/download/release/v24.21.0/node-v24.21.0-x64.msi" -OutFile $ticketpilotNodeMsi -ErrorAction Stop
Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", "`"$ticketpilotNodeMsi`"") -Wait
```

指令會開啟安裝視窗，仍需依畫面完成操作。ARM64 Windows 請使用上方下載連結。

</details>

安裝完成後，重新開啟終端機，確認能顯示版本：

```bash
node --version
npm --version
```

## 2. 下載專案並安裝依賴

在 GitHub 按 **Code → Download ZIP**，下載並解壓縮，不需要安裝 Git。

開啟終端機，切換到含有 `package.json` 的專案資料夾，再安裝依賴。請將下方路徑換成實際位置：

```bash
cd "你的專案資料夾路徑"
npm ci
```

第一次下載或換到新資料夾時需要安裝依賴，平常啟動不用重裝。

## 3. 開啟 GUI

在專案資料夾執行以下指令，啟用自動化識別參數測試並開啟 GUI。

**macOS／Linux：**

```bash
WEBDRIVER_EXPERIMENT=1 npm run gui
```

**Windows PowerShell：**

```powershell
$env:WEBDRIVER_EXPERIMENT = "1"
npm run gui
```

程式會自動開啟網頁，依畫面設定 TicketPlus 活動後即可開始。需要登入時，請在另開的購票 Chrome 手動登入 TicketPlus。

使用期間保留終端機視窗。若網頁沒有自動開啟，複製終端機顯示的本機網址到瀏覽器即可。使用完畢後，先關閉購票 Chrome，再於終端機按 `Ctrl+C` 結束工具。

> Windows PowerShell 若提示 `npm.ps1` 無法執行，請改用 `npm.cmd`，例如 `npm.cmd ci`、`npm.cmd run gui`。

## TicketPlus 購票與登記抽選

使用 `WEBDRIVER_EXPERIMENT=1 npm run gui` 開啟介面後直接進入 TicketPlus 活動列表，新增或編輯活動。在「活動與順位」保存活動與同場次購票順位，再到「確認與開始」核對摘要、設定執行時間並開始。TicketPlus CLI 已移除，不再提供 `start:ticketplus` 或 `--config` 入口；`ticketplus.example.json` 保留作為資料格式範例，不會由 GUI 自動匯入。

程式先開啟 TicketPlus 首頁並等待會員區載入。若尚未登入，請在購票 Chrome 手動登入；系統確認後會自動前往設定活動，無須按 Enter。會員聯絡欄位由網站帶入；工具不需要聯絡資料設定檔，也不比對會員聯絡資料。

可選立即開始或指定開賣時間，指定模式可提前 1／2 秒刷新。開賣後只有目標場次明確顯示尚未開賣，才間隔至少 3 秒再次刷新，最多等待至開賣後 2 分鐘。

購票順位目前限同日期、同時間。只有明確售完才略過票種；提交後辨識售完、關閉彈窗且重新核對通過，才嘗試本輪下一順位。順位耗盡後更新票數，確認更新完成才從第一順位開始新輪。未知畫面、殘留張數、一般失敗、更新無法確認或提交結果不明均停止，不盲目重送。抵達同場次資料頁後，程式核對必要資料、勾選服務條款並按一次下一步，確認到達付款頁後停止，不按「前往付款」。坐席活動會先核對確認選位結果的票區與張數，不符即停止。

選擇「登記抽選」時，抵達輸入資料頁後等待你在購票瀏覽器填寫每位參加者。填完後回 GUI 按「參加者已填完」；程式核對人數與填寫狀態，再按一次下一步，停在「確認登記」之前。工具不讀取、不保存參加者的證件資料，最後登記由你確認。

最長執行時間須為 10～1440 的整數分鐘。新活動與舊缺值活動預填 10；舊 1～9 分鐘設定可載入，但須修改後才能啟動。期限從開始選場次前計算，不包含登入、開賣等待及抽選參加者填寫等待。GUI 可要求停止；送出要求不代表已停止，需等執行結果確認。停止不代表取消網站端請求，購票瀏覽器會保留供人工檢查。

`WEBDRIVER_EXPERIMENT=1` 仍是選用的瀏覽器參數開關。TicketPlus 使用獨立的 `browser-profile-ticketplus/` 保存登入，本機設定與登入資料不納入版本控制。操作結束後請關閉購票 Chrome，流程與瀏覽器都結束後才釋放購票占用；異常中斷時先人工確認瀏覽器與訂單狀態，不自動清鎖。

## 舊 Klook 版本與資料

`main` 只支援 TicketPlus。完整 Klook 程式及當時文件保存在 `archive/klook` 分支。

本機舊 Klook 活動與執行紀錄保留原始檔案，不會自動升版、改寫或刪除，也不再顯示於 GUI。GUI 與 API 不接受新增、修改、載入、刪除或執行 Klook 活動；既有 Klook 請求 ID 不能重用。需要管理舊活動時，先停止 GUI 並確認沒有購票程序或未處理提交，再使用保留分支。

切換分支不會還原或清除 `local-data/`、私人聯絡資料及瀏覽器登入資料。既有購票占用鎖也不會因隱藏 Klook 紀錄而解除；沒有可顯示紀錄但仍有占用時，GUI 會要求人工確認，不自動開始下一次購票。

## 系統架構

想了解主要模組如何傳遞設定、進度與控制訊息，請從 [系統架構與資料流](docs/architecture/README.md) 開始閱讀。
