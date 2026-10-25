# 1. 開始購票與回報進度

```mermaid
sequenceDiagram
    participant G as GUI
    participant B as 後端服務
    participant D as 資料檔案
    participant W as 購票子程序

    G->>B: SSE：連線接收狀態更新
    B-->>G: SSE：傳送目前狀態
    G->>G: 記住請求編號，避免重複開始
    G->>B: HTTP API：開始購票，附上請求編號與設定
    B->>D: 讀取檔案：查看已存設定
    D-->>B: 回傳設定
    B->>B: 確認與 GUI 傳來的設定一致
    B->>D: 讀取紀錄：這個請求是否已處理
    D-->>B: 回傳查詢結果
    B->>B: 確認是新請求、設定可用且沒有子程序占用
    B->>D: 檢查檔案：占用鎖是否存在
    D-->>B: 回傳鎖檔是否存在
    B->>B: 確認沒有鎖檔占用，且時間設定允許啟動
    B->>D: 建立鎖檔，防止同時購票
    B->>D: 寫入檔案：記下這次執行
    B->>W: 建立購票子程序（fork）
    B->>W: IPC：傳送購票設定與占用憑證
    B-->>G: SSE：推送正在啟動的狀態
    B-->>G: HTTP API 回應：已受理，正在啟動

    rect rgb(255, 244, 204)
        loop 每次有新的進度或狀態
            W-->>B: IPC：回報進度或瀏覽器開關狀態
            B->>B: 檢查回報內容，更新目前狀態
            B->>D: 寫入檔案：保存最新紀錄
            B-->>G: SSE：傳送完整的最新狀態
        end
    end

    W-->>B: IPC：回報自動操作結果
    B->>B: 檢查結果內容，更新目前狀態
    B->>D: 寫入檔案：保存結果
    B-->>G: SSE：傳送結果與目前可用操作
```

圖中呈現新的開始請求通過檢查後的流程；重複請求不會再次啟動購票。

## 重要設計

- **避免重複購票：** 後端先建立占用鎖、保存紀錄，才啟動子程序。同一請求再次送來且核對一致時，回傳原結果，不重新購票。
- **進度回報不阻塞購票：** 子程序不必等待 GUI 更新，才繼續操作。HTTP 回應與 SSE 更新也可能交錯到達；「已受理」不代表購票瀏覽器已準備好。
- **結果與收尾分開：** 回報結果後，瀏覽器可能仍開著，占用尚未解除。後續處理見 [第二節](close-and-release.md)。

## 對應程式

- [GUI 開始請求](../../src/gui/platforms/ticketplus/startPurchase.ts)：保存設定、待確認請求及開始 API。
- [GUI 狀態訂閱](../../src/gui/shared/runs/useRunStatus.ts)：SSE 與初始查詢。
- [購票 API](../../src/server/routes/purchaseRoutes.ts)：設定比對與 SSE。
- [執行管理](../../src/server/runs/purchaseRuns.ts)：`start`、`previousResult`、`attachWorker`。
- [購票子程序](../../src/workers/purchaseWorker.ts)：IPC 與結果回報。

[← 導覽](README.md) · [下一節：關閉瀏覽器與解除占用 →](close-and-release.md)
