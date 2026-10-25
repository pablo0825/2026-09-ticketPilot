# 2. 關閉瀏覽器與解除占用

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

圖中呈現自動操作已有結果後，從 GUI 關閉瀏覽器且成功解除占用的流程。

## 重要設計

- **由子程序核對並解鎖：** 流程與瀏覽器都結束後，子程序才核對占用憑證並刪除鎖檔。直接關閉購票瀏覽器，也必須滿足相同條件。
- **收尾通知不等於已結束：** 後端會等子程序結束，再確認瀏覽器與占用都已解除，才回覆關閉成功。收到購票結果不代表已付款或完成最終登記。
- **失敗時不強制解鎖：** 關閉失敗、逾時或解鎖失敗時，會回報問題，保留現況供人工檢查。

## 對應程式

- [關閉與結束管理](../../src/server/runs/purchaseRuns.ts)：`closeBrowser`、`attachWorker`。
- [子程序控制](../../src/workers/purchaseWorker.ts)：關窗訊息、`result` 與 `finished`。
- [TicketPlus 流程](../../src/app/flows/ticketplus/runTicketPlus.ts)：`release` 與瀏覽器關閉事件。
- [占用鎖](../../src/storage/purchaseLock.ts)：`verifyPurchaseLease`、`releasePurchaseLease`。

[← 上一節：開始購票與回報進度](start-and-progress.md) · [導覽](README.md) · [下一節：子程序異常結束 →](interrupted-run.md)
