# GUI 第一批：階段 1–3

本批提供設定資料層、共用購票入口，以及本機 HTTP／子程序／SSE 串接預覽。
**網頁只有模擬執行，不能實際購票。** 原本 `npm start` 保留既有 CLI 實站流程。

## 使用

```sh
npm run gui
# 不自動開頁（例如測試環境）
npm run gui -- --no-open
```

程式印出並開啟 `http://127.0.0.1:<自動分配連接埠>`。在頁面按「新增示範活動」，再按「開始模擬」。模擬使用虛構個資，不讀取或修改使用者的 contact.local.json，不連線 Klook。
重新整理頁面會取得本服務目前的模擬狀態，不重新啟動。Ctrl+C 關閉本機服务與模擬子程序。服務重啟不自動續跑，先前模擬紀錄只存在記憶體。

## 設定格式與儲存

活動位置固定為專案根目錄下 `local-data/events/<UUID>.json`，不依啟動 cwd 改變，已加入 Git 排除。檔案格式：

```json
{
    "schemaVersion": 1,
    "id": "由程式產生的 UUID",
    "updatedAt": "2026-10-03T00:00:00.000Z",
    "settings": {
        "eventUrl": "https://www.klook.com/zh-TW/event-detail/example/",
        "eventName": "示範活動",
        "fallbackMode": "STRICT",
        "excludeKeywords": ["愛心席", "身障", "視線不良"],
        "targets": [
            {
                "date": "2026-11-02",
                "time": "19:30",
                "area": "B區",
                "unitPrice": 5280,
                "quantity": 1,
                "adjacent": false
            }
        ]
    }
}
```

可選 `settings.saleSchedule` 沿用 `{ "saleAt": "2026-11-01T10:00:00+08:00", "advanceSeconds": 1 }`；以上皆為格式範例。未設代表立即開始。各順位 expectation 由共用轉換產生，總額為單價×張數，超出安全整數或頁面額外費用不放寬驗證。

ActivityStore 支援新增、載入、列出及依 ID 更新；同名活動不互相覆蓋，未知版本或損壞檔案列入無法載入計數。驗證成功後寫暫存檔再替換。個資 `saveContactDetails` 沿用原欄位驗證，與活動分開保存；本批沒有個資網頁表單或保存 API，不改 contact.example.json。

## 共用核心

- `src/app/runPurchase.ts` 接收本次 config／contact 快照，沒有 import 即執行或讀取全域 eventConfig。
- CLI 的 `src/main.ts` 仍從 event.config.ts 與 contact.local.json 載入，不靜默改用 GUI 活動。
- 原開賣、順位、恢復額度、座位確認、單次個資提交與付款前停止規則保留。
- 巢狀狀態／日誌由每次執行的事件出口接收；同步或非同步 listener 錯誤不觸發購票恢復。
- CLI 的 FLOW_PAUSE／停止診斷 Enter 行為維持；GUI 模擬子程序不啟用 TTY 暫停。

## 模擬 API

本機服務只監聽 127.0.0.1，要求正確 Host／Origin 與當次頁面 token。

- GET/POST `/api/activities`：列出／新增。
- GET/PUT `/api/activities/:id`：載入／更新。
- POST `/api/simulation`：完整活動＋虛構聯絡資料驗證後啟動單一模擬；需要 requestId、activityId、contact。
- GET `/api/run`：目前模擬快照。
- GET `/api/events`：SSE，推送目前完整快照；有限事件紀錄與序號，重連不執行購票。

沒有實站執行 API。相同 requestId 與相同內容不重啟；相同 ID 改內容拒絕。設定在父程序驗證並複製後透過 IPC 傳入，子程序不重讀檔案。執行中第二個開始請求會拒絕。事件不輸出 contact 原文，worker stdout/stderr 不轉送網頁。本服務每次最多保留 100 筆去重紀錄，超過需重新啟動模擬服務。

## 下一批（尚未完成）

完整活動／個資表單、正式狀態摘要、實站 worker 與瀏覽器占用管理、CLI/GUI profile 互斥、異常退出與服務重啟的人工處理，以及完整操作介面，屬於階段4–6。未加入複製、刪除或 GUI 停止按鈕。

本批驗證以本機 JSON、攔截頁面與模擬子程序為主；沒有透過新介面實站購票。示範成功不能當作購票成功。
