# 1. 開始購票與回報進度

這張圖回答：按下開始後，設定交給誰，進度又怎麼回到 GUI？

情境：活動設定已儲存，新的開始請求通過檢查，子程序能正常回報。圖從 GUI 訂閱狀態開始，畫到自動操作回報結果。

```mermaid
sequenceDiagram
    participant G as GUI
    participant B as 後端服務
    participant D as 資料檔案
    participant W as 購票子程序

    G->>B: SSE：GUI 開啟時，訂閱後續狀態
    B-->>G: SSE：傳送目前狀態
    G->>G: 記住這次請求編號，避免回應遺失後重複開始
    G->>B: HTTP API：請開始購票，附上請求編號與設定
    B->>D: 讀取檔案：查看已存設定
    D-->>B: 回傳設定
    B->>B: 確認與 GUI 傳來的設定一致
    B->>D: 讀取檔案：查看這個請求是否已執行
    D-->>B: 回傳查詢結果
    B->>B: 確認是新請求，且目前可以啟動
    B->>D: 寫入鎖檔：先保留購票使用權
    B->>D: 寫入檔案：記下這次執行
    B->>W: 建立購票子程序（Node.js fork）
    B->>W: IPC：傳送購票設定與占用憑證
    B-->>G: SSE：推送正在啟動的狀態
    B-->>G: HTTP API 回應：已受理，正在啟動

    rect rgb(255, 244, 204)
        loop 有新的進度或狀態要回報時
            W-->>B: IPC：回報進度或瀏覽器開關狀態
            B->>B: 檢查回報內容，更新目前狀態
            B->>D: 寫入檔案：保存最新紀錄
            B-->>G: SSE：傳送完整的最新狀態
        end
    end

    W-->>B: IPC：回報這次自動操作的結果
    B->>B: 檢查結果內容，更新目前狀態
    B->>D: 寫入檔案：保存結果
    B-->>G: SSE：傳送結果與目前可用操作
```

## 閱讀重點

- GUI 載入時也會發出 `GET /api/purchase` 讀取目前狀態，與 SSE 訂閱並行。開始購票不必等待 SSE 連線成功；GUI 需要先取得可用狀態。
- 開始請求是 `POST /api/purchase`，包含 `requestId`、`activityId` 和 `expectedActivity`。若設定有修改，GUI 先保存，再以 `sessionStorage` 記住待確認的請求。
- 啟動檢查包含設定、重複請求、占用及開賣時間。同一請求再次送來且核對一致時，直接回傳既有結果，不重新啟動；換設定、換活動或無法確認相容性時拒絕。
- 後端先建立 `purchase.lock`，再保存執行紀錄，最後啟動子程序。啟動途中出錯不會自行猜測可以重跑。
- 「已受理」不代表購票瀏覽器已準備好。啟動時後端先通知 SSE，再寫 HTTP 回應，但 GUI 收到的順序不保證。
- 黃色區塊是事件回報，不是每個網站操作都要走一次。子程序不等待後端存檔或 GUI 更新後才繼續操作。後端只處理通過驗證的回報。
- 子程序回報 `outcome`、`message` 和選填的 `stopReason`；後端另外計算 GUI 現在可以做哪些操作。結果回報後仍可能保留購票瀏覽器，等待人工接手。

## 對應程式

- [GUI 開始請求](../../src/gui/platforms/ticketplus/startPurchase.ts)：保存設定、待確認請求及開始 API。
- [GUI 狀態訂閱](../../src/gui/shared/runs/useRunStatus.ts)：SSE 與初始查詢。
- [購票 API](../../src/server/routes/purchaseRoutes.ts)：設定比對與 SSE。
- [執行管理](../../src/server/runs/purchaseRuns.ts)：`start`、`previousResult`、`attachWorker`。
- [購票子程序](../../src/workers/purchaseWorker.ts)：IPC 與結果回報。

[← 導覽](README.md) · [下一節：關閉瀏覽器與解除占用 →](close-and-release.md)
