# TicketPilot

透過本機網頁介面設定並執行 Klook 購票流程，工具會停在付款頁，付款需自行完成。

## 1. 準備環境

先安裝 **Node.js 24 LTS**（內含 npm）與 **Google Chrome**，並準備 Klook 帳號。已安裝的使用者可略過。

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

程式會自動開啟網頁，依畫面設定活動與聯絡資料後即可開始。需要登入時，請在另開的購票 Chrome 手動登入 Klook。

使用期間保留終端機視窗。若網頁沒有自動開啟，複製終端機顯示的本機網址到瀏覽器即可。使用完畢後，先關閉購票 Chrome，再於終端機按 `Ctrl+C` 結束工具。

> Windows PowerShell 若提示 `npm.ps1` 無法執行，請改用 `npm.cmd`，例如 `npm.cmd ci`、`npm.cmd run gui`。
