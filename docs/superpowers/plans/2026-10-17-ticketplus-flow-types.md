# TicketPlus 購票／抽選流程類型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依使用者勾選的流程類型（購票／抽選）執行 TicketPlus：自動關閉已知活動提醒彈窗、以步驟條驗證流程類型；抽選在使用者人工填完參加者並於 GUI 確認後，勾條款、按一次下一步，停在「確認登記」之前。

**Architecture:** 購票（演唱會 A、C）與抽選共用活動頁、選場次、選票、提交與排隊模組；實站顯示 A 與 C 路徑相同（order → confirm → checkout），不另分流程。流程類型只影響：場次按鈕文字、排隊文案、步驟條驗證，以及抽選到 confirm 頁後的人工確認與停止點。購票成功仍停在 `information-ready`，行為不變。

**Tech Stack:** TypeScript (strict)、Playwright、zod、React GUI、`node:test`、`node:assert/strict`、tsx。

**Spec:** `docs/ticketplus-flow-types-observation.md`（實站觀察與「使用者決定」一節）

## Global Constraints

- 四空白縮排、分號、`.js` 相對 import、`import type`；較長函式以簡短中文註解分段（AGENTS.md）。
- 流程類型值只有 `"purchase"`、`"lottery"`；舊設定沒有此欄位時視為 `"purchase"`，不改寫舊紀錄、不影響歷史指紋。
- 提醒彈窗白名單標題只有「實名抽選制售票提醒」「入場規定」，只按該彈窗內唯一可見啟用的「確定」，每次頁面載入最多一次；永不按「回到首頁」。其他彈窗維持原本停止規則。
- 步驟條文字完整比對：購票 `選擇票種/填寫資料/付款結帳` 或 `選擇票區/選擇座位/確認資料/付款結帳`；抽選 `選擇票種/輸入資料/確認資料/登記成功`。
- 參加者姓名、證件號碼只在瀏覽器內轉成布林值，不得進入 Node、IPC、紀錄或錯誤訊息（頁面顯示的證件號碼未遮罩）。
- 抽選：不讀取、不保存、不填寫參加者資料；不採用自動偵測填完；勾條款與按下一步各最多一次、不重試；永不按「確認登記」或「取消登記」。
- TicketPlus 不比對聯絡人、不需要 `contact.local.json`。
- 每個 commit 後：`npm run typecheck`、相關測試、依下表的子代理審查；全部 task 完成後跑一次 `npm test`。

| Task | 審查 |
| --- | --- |
| 1 | 品質、回歸 |
| 2 | 品質、回歸、套套邏輯 |
| 3 | 品質、回歸 |
| 4 | 品質、回歸、套套邏輯 |
| 5 | 品質、回歸、套套邏輯 |
| 6 | 品質、回歸 |

## Review Focus

- 抽選活動被設成購票（或反之）：場次按鈕文字不符必須在點擊前停止（`flow-mismatch`），不可點「立即登記」走購票流程。
- A 的 order 頁先顯示 3 步佔位再換成 4 步：購票設定不可因佔位而停止；抽選設定看到購票 3 步時須等待到期限，不可立即判定不符也不可直接放行。
- 提醒彈窗按「確定」後同一次載入又出現：必須停止，不可第二次點擊。
- 使用者在 GUI 確認時編輯表單或「關閉表單」確認仍開著：必須停止，不勾條款、不按下一步。
- 抽選按下一步後頁面停在 confirm 或出現未知彈窗：回報 `unknown`，不重按下一步。

---

### Task 1: 活動設定加入流程類型

**Files:**
- Modify: `src/config/ticketPlusActivity.ts`（`activitySchema`、新增 helper）
- Modify: `src/local/react/platforms/ticketplus/formModel.ts`、`ActivityEditor.tsx`、`ActivityList.tsx`（顯示類型）
- Test: `tests/ticketPlusSettings.test.ts`、`tests/ticketPlusForm.test.ts`、`tests/ticketPlus.gui.test.ts`

**Interfaces:**
- Produces: `export type TicketPlusFlowType = "purchase" | "lottery";`、`export function ticketPlusFlowType(settings: TicketPlusActivitySettings): TicketPlusFlowType`（欄位缺少回 `"purchase"`）。schema 新增 `flowType: z.enum(["purchase", "lottery"]).optional()`。

- [ ] 測試：缺 `flowType` 的舊設定可解析且 `ticketPlusFlowType` 為 `"purchase"`；`"lottery"` 可解析；`"seated"` 被拒並回原錯誤訊息；解析結果不新增欄位（`"flowType" in parsed === false`）。
- [ ] 測試（表單／GUI）：編輯器有「購票」「登記抽選」兩個 radio，預設購票；選抽選後存檔內容含 `flowType: "lottery"`；活動列表顯示類型。
- [ ] 跑測試確認失敗，實作 schema、helper 與 GUI，跑測試通過，typecheck 通過。
- [ ] `invalidSettings` 文案加入「流程類型」。
- [ ] Commit `feat(ticketplus): add flow type setting`。

### Task 2: 自動關閉已知活動提醒彈窗

**Files:**
- Modify: `src/platforms/ticketplus/domSnapshot.ts`（dialog `kind` 新增 `"notice"`、`noticeTitle`）
- Create: `src/platforms/ticketplus/activityNotice.ts`
- Modify: `src/platforms/ticketplus/sessionSelection.ts`（點場次前處理）
- Create: `tests/fixtures/ticketplus/activityNotice.ts`；Test: `tests/ticketPlusActivityNotice.test.ts`、`tests/ticketPlusSession.test.ts`

**Interfaces:**
- Produces: snapshot dialog 新增 `kind: "notice"` 與 `noticeTitle?: "實名抽選制售票提醒" | "入場規定"`。判定：路徑為 `/activity/`、彈窗第一個非空文字行完全等於白名單標題、可見啟用按鈕恰為「回到首頁」「確定」各一。
- Produces: `export async function dismissTicketPlusActivityNotice(page: Page, control: TicketPlusRunControl): Promise<"none" | "dismissed">`；失敗丟 `TicketPlusSessionError`，新 reason `"notice-dismiss-failed"`（加入 `SessionEntryReason`）。

- [ ] Fixture：依觀察的 `.v-dialog__content[role="dialog"] > .v-dialog.v-dialog--active.v-dialog--persistent` 結構，提供兩種標題、未知標題、按鈕缺漏、點後重現四種模式，並計數兩顆按鈕點擊次數。
- [ ] 測試：兩種標題各點「確定」1 次、「回到首頁」0 次、回 `"dismissed"`；無彈窗回 `"none"` 且 0 點擊；未知標題、按鈕不齊皆 0 點擊並停止；點後同一載入重現 → 停止且總點擊 1；彈窗在 order 路徑不算 notice。
- [ ] 實作 snapshot 判定與模組：點擊前以同規則重新定位同一顆按鈕，點後等到 notice 消失（沿用 control 期限）。
- [ ] `selectTicketPlusSession`：活動頁只有 notice 彈窗時呼叫一次 dismiss 再繼續原流程；每次導覽／重載重設該次載入的點擊額度。
- [ ] 跑 `ticketPlusActivityNotice`、`ticketPlusSession`、`ticketPlusPage`、`ticketPlusActivityLoading` 通過；typecheck。
- [ ] Commit `feat(ticketplus): dismiss known activity notices`。

### Task 3: 抽選場次按鈕與排隊文案

**Files:**
- Modify: `src/platforms/ticketplus/activityPage.ts`（接受「立即登記」）
- Modify: `src/platforms/ticketplus/sessionSelection.ts`（依流程類型核對按鈕）
- Modify: `src/platforms/ticketplus/domSnapshot.ts`（`queueCount`、queue dialog 接受「排隊登記中 請稍候」）
- Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusSession.test.ts`、`tests/ticketPlusSubmission.test.ts`

**Interfaces:**
- Consumes: Task 1 `TicketPlusFlowType`。
- Produces: `SessionSelectionOptions` 新增 `flowType: TicketPlusFlowType`；`SessionEntryReason` 新增 `"flow-mismatch"`。購票只點「立即購買」、抽選只點「立即登記」。

- [ ] 測試：活動頁「立即登記」列解析為 `saleState: "available"`；抽選設定點「立即登記」1 次；購票設定遇「立即登記」、抽選設定遇「立即購買」皆 0 點擊並停止 `flow-mismatch`；「尚未開賣」行為不變。
- [ ] 測試：h3「排隊登記中 請稍候」算排隊、提交後等待不誤判 unknown；附加文字「若人數眾多可能需要較長等待時間」存在時仍算同一排隊。
- [ ] 測試：抽選「輸入資料」confirm 頁（含登記明細、參加者資訊、聯絡人、條款、取消登記、下一步）由 `parseInformationPage` 解析為 `information`，提交等待得 `information-ready`；A 的 confirm 頁（含選擇優惠 radio 與折扣碼輸入框）同樣解析成功。
- [ ] 實作，跑上列測試與 `ticketPlusCycle`、`ticketPlusRounds` 通過；typecheck。
- [ ] Commit `feat(ticketplus): support lottery session entry`。

### Task 4: 以步驟條驗證流程類型

**Files:**
- Modify: `src/platforms/ticketplus/domSnapshot.ts`（新增 `steps: { text: string; state: "current" | "checked" | "after" | "unknown" }[]`，讀 `.stepperPadding .stepText` 可見元素）
- Create: `src/platforms/ticketplus/flowSteps.ts`
- Modify: `src/app/runTicketPlus.ts`（選場次後、選票前呼叫一次）
- Test: `tests/ticketPlusFlowSteps.test.ts`、`tests/ticketPlusRunner.test.ts`

**Interfaces:**
- Produces: `export function classifyTicketPlusSteps(steps: readonly { text: string }[]): "purchase" | "lottery" | "unknown"`。
- Produces: `export async function verifyTicketPlusFlow(page: Page, flowType: TicketPlusFlowType, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<void>`，預設 `timeoutMs: 5_000`；不符丟 `TicketPlusFlowError`，`reason: "flow-mismatch" | "flow-unknown"`。
- Produces: `TicketPlusRunResult` 停止原因新增 `"flow-check-stopped"`，帶 `flowFailure`。

- [ ] 測試 classify：三組完整清單各自分類；順序不同、少一步、多空白、混入其他文字皆 `unknown`。
- [ ] 測試 verify：購票設定看到購票 3 步立即通過；看到 3 步後換 4 步也通過；抽選設定看到抽選步驟通過；抽選設定只看到購票 3 步直到逾時 → `flow-mismatch`；購票設定看到抽選步驟 → 立即 `flow-mismatch`；整個期間無步驟條 → `flow-unknown`。全程 0 點擊。
- [ ] 實作；runner 測試確認購票成功流程仍得 `information-ready`，flow 失敗不提交、不重試。
- [ ] `ticketPlusPresentation.ts` 補兩個停止文案：「流程類型與頁面不符，請檢查活動設定」「無法辨識購票步驟」。
- [ ] 跑相關測試與 typecheck；Commit `feat(ticketplus): verify flow type from stepper`。

### Task 5: 抽選參加者核對與停止點（平台模組）

**Files:**
- Modify: `src/platforms/ticketplus/domSnapshot.ts`（新增 `applicants: { filled: boolean }[]`、`registerButtons: boolean[]`（「確認登記」enabled））
- Create: `src/platforms/ticketplus/lotteryCompletion.ts`
- Create: `tests/fixtures/ticketplus/lotteryPages.ts`；Test: `tests/ticketPlusLotteryCompletion.test.ts`

**Interfaces:**
- Consumes: `VerifiedTicketPlusSession`、`TicketPlusRunControl`、Task 4 `classifyTicketPlusSteps`。
- Produces: `export type LotteryCompletionResult = { outcome: "registration-ready" } | { outcome: "stopped" | "unknown"; reason: LotteryStopReason };`，`LotteryStopReason = "not-input-page" | "dialog-open" | "participant-count" | "participant-incomplete" | "terms-missing" | "next-unavailable" | "checkout-not-reached" | "time-limit" | "user-stopped"`。
- Produces: `export async function completeTicketPlusLottery(page: Page, session: VerifiedTicketPlusSession, quantity: number, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<LotteryCompletionResult>`，預設 `timeoutMs: 15_000`。

`filled` 判定（瀏覽器內）：`.row.applicant-info` 的 `.applicant-number` 沒有 `grey` class，且 `.row.pl-5` 第 2 格起至少一格有文字。只回傳布林值。

- [ ] Fixture：依觀察建立 confirm「輸入資料」頁（登記明細、參加者列、聯絡人、條款、下一步）與 checkout「登記成功」頁（三步 checked、上一步、確認登記）；可設定已填列數、開啟編輯表單、關閉表單確認、下一步按後停留原頁。
- [ ] 測試：1 列已填 → 勾條款 1 次、下一步 1 次、`registration-ready`，「確認登記」0 點擊；條款已勾 → 勾選 0 次；列數 ≠ quantity、任一列未填、編輯表單或關閉確認開著、步驟條非「輸入資料」→ 0 點擊 `stopped`；下一步後未到 checkout → `unknown` 且下一步總點擊 1；斷言測試輸出與結果物件不含 fixture 的姓名與證件號碼字串。
- [ ] 實作：核對 → 勾條款（未勾才點）→ 確認下一步啟用 → 點一次 → 等同場次 `/checkout/`、步驟條抽選且 current 為「登記成功」、唯一「確認登記」存在。
- [ ] 跑測試、typecheck；Commit `feat(ticketplus): complete lottery up to registration confirm`。

### Task 6: 執行器、worker、API 與 GUI 人工確認

**Files:**
- Modify: `src/app/runTicketPlus.ts`（抽選 `information-ready` 後等待確認再呼叫 Task 5）
- Modify: `src/local/ticketPlusWorker.ts`、`src/local/purchaseWorker.ts`（接收確認訊息）
- Modify: `src/local/purchaseRuns.ts`、`src/local/server.ts`（新 API、狀態）
- Modify: `src/local/react/platforms/ticketplus/PurchaseSummary.tsx`、`startPurchase.ts`
- Modify: `src/app/ticketPlusPresentation.ts`、`docs/gui-usage.md`
- Test: `tests/ticketPlusRunner.test.ts`、`tests/ticketPlusWorker.test.ts`、`tests/ticketPlusApi.test.ts`、`tests/ticketPlusStart.gui.test.ts`

**Interfaces:**
- Consumes: Task 5 `completeTicketPlusLottery`。
- Produces: `TicketPlusStage` 新增 `"waiting-for-participants"`、`"completing-registration"`；`TicketPlusRunOptions` 新增 `waitForParticipants?: (confirmationId: string) => Promise<void>`（由 worker 注入，resolve 表示收到確認）。
- Produces: worker 收 `{ type: "confirm-ticketplus-participants", confirmationId }` 只接受一次、ID 須相符；snapshot 新增 `participantConfirmation?: { confirmationId: string }`；`POST /api/purchase/confirm-participants` body `{ runId, confirmationId }`，沿用 token／來源防護；執行狀態新增 `"registration-ready"`（終態，保留瀏覽器與占用，同 `information-ready`）。

- [ ] 測試 runner：抽選到資料頁後發出 `waiting-for-participants`、未確認前 0 點擊；確認後得 `registration-ready`；等待中達全程期限或使用者停止 → `stopped`，不勾條款；購票流程不等待、結果仍為 `information-ready`。
- [ ] 測試 worker／API：錯 ID、重複、提早、流程結束後的確認皆拒絕且不轉送；正確確認轉送一次；`registration-ready` 寫入紀錄並可關閉瀏覽器。
- [ ] 測試 GUI：等待時顯示「請在購票瀏覽器填寫所有參加者，完成後按『參加者已填完』；網站倒數結束前須完成」與按鈕；按下後同頁不可重按；`registration-ready` 顯示「已停在確認登記前，請自行檢查並送出」。
- [ ] 實作；更新 `docs/gui-usage.md` 的抽選操作說明。
- [ ] 跑相關測試與 typecheck；Commit `feat(ticketplus): confirm lottery participants from GUI`。
- [ ] 全部完成後跑 `npm test` 一次，回報結果；實站驗證另由使用者授權進行。
