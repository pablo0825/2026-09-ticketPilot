# 2. 關閉瀏覽器與解除占用

子程序確認流程與瀏覽器都已結束後，核對並解除占用。後端再確認子程序已結束，回覆 GUI。

適用情境：自動操作已有結果，從 GUI 關閉仍開啟的購票瀏覽器，而且關閉與解鎖都成功。

```mermaid
sequenceDiagram
    participant G as GUI
    participant B as 後端服務
    participant D as 資料檔案
    participant W as 購票子程序

    G->>B: HTTP API：請關閉這次購票的瀏覽器
    B->>B: 確認執行編號正確，且可以關閉
    B->>W: IPC：請關閉瀏覽器
    W->>W: 要求關閉瀏覽器
    W->>W: 收到瀏覽器關閉通知，確認流程已結束
    W->>D: 讀取鎖檔，核對占用憑證
    D-->>W: 回傳鎖檔內容
    W->>D: 刪除鎖檔：解除購票占用
    W-->>B: IPC：瀏覽器已關閉
    B->>D: 寫入檔案：保存瀏覽器狀態
    B-->>G: SSE：更新目前狀態
    W-->>B: IPC：回報收尾完成（finished）
    B->>B: 記住子程序已回報收尾完成
    B->>D: 寫入檔案：保存目前紀錄
    B-->>G: SSE：更新目前狀態
    W->>W: 斷開 IPC，結束子程序
    B->>B: 收到子程序結束通知
    B->>D: 檢查是否仍有占用鎖，保存最新狀態
    B-->>G: SSE：推送最新狀態
    B-->>G: HTTP API 回應：已關閉，占用已解除
```

## 先記住這三件事

1. **子程序負責解鎖。** 後端不會因收到結果，就直接刪除鎖檔。
2. **瀏覽器關閉後，還有收尾。** 後端要等子程序結束，再確認是否仍被占用。
3. **關閉失敗時不強制解鎖。** 需要檢查原瀏覽器與訂單，不能直接開始下一輪。

## 技術補充

### 關閉請求與解鎖

- GUI 呼叫 `POST /api/purchase/close-browser`。後端核對執行 ID 和關閉資格；仍在執行自動操作時，不能使用這個操作關窗。
- 解鎖的是子程序內的流程程式，不是後端。在這張圖的情境中，瀏覽器 `close` 事件會觸發解鎖檢查。流程的監聽器比 worker 的瀏覽器狀態回報先註冊，因此先確認流程也已結束、核對 token 並刪除鎖檔，再回報瀏覽器已關閉。

### 結果、收尾通知與程序結束

- `result` 表示自動操作有結果；`finished` 表示 worker 已走到收尾通知。後端還要檢查子程序是否正常結束，以及鎖檔是否仍存在，不能只憑一個訊息判定已解除占用。
- 收到 `finished` 時，後端在記憶體設定 `clean = true`，再把目前紀錄寫一次；不會新增一個持久保存的「已收尾」欄位。

### 其他關閉情況

- 使用者也能直接關閉購票瀏覽器。此時沒有前面的 GUI 關閉請求，但仍由子程序在流程與瀏覽器都結束後處理解鎖。
- 圖中省略 IPC 斷線時的額外 SSE 通知。正常路徑的最後 HTTP 回應會等待子程序結束並確認沒有占用；關閉失敗、逾時或解鎖失敗時，會回報問題，不會強制刪鎖。
- 即使鎖檔已刪除，只要後端仍持有這個子程序，仍會視為占用，避免過早開始下一輪。

## 對應程式

- [關閉與結束管理](../../src/server/runs/purchaseRuns.ts)：`closeBrowser`、`attachWorker`。
- [子程序控制](../../src/workers/purchaseWorker.ts)：關窗訊息、`result` 與 `finished`。
- [TicketPlus 流程](../../src/app/flows/ticketplus/runTicketPlus.ts)：`release` 與瀏覽器關閉事件。
- [占用鎖](../../src/storage/purchaseLock.ts)：`verifyPurchaseLease`、`releasePurchaseLease`。

[← 上一節：開始購票與回報進度](start-and-progress.md) · [導覽](README.md) · [下一節：子程序異常結束 →](interrupted-run.md)
