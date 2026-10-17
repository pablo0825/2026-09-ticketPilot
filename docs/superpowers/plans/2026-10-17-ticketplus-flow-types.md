# TicketPlus 購票／抽選流程類型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依使用者選擇的流程類型（購票／抽選）執行 TicketPlus：自動關閉已知活動提醒彈窗、在活動頁以場次按鈕文字確認流程類型；購票在資料頁勾條款、按一次下一步，停在付款頁「前往付款」之前；抽選在使用者人工填完參加者並於 GUI 確認後，勾條款、按一次下一步，停在「確認登記」之前。

**Architecture:** 購票（演唱會 A、C）與抽選共用活動頁、選場次、選票、提交與排隊模組；一般購票有三種頁面順序（C 與 A 站席：order → confirm → checkout；A 坐席：order → confirmSeat → confirm → checkout），不另分 A／C 設定，由提交後實際到達的頁面決定是否核對座位。頁面判斷：網址決定頁面種類，同一次 DOM 快照的內容確認已載入完整並分辨購票或抽選（confirm：有無「參加者資訊」；checkout：「前往付款」或「確認登記」），不讀步驟條。流程類型影響：場次按鈕文字、排隊文案、confirm 頁的處理（購票勾條款按下一步；抽選等待人工確認）與停止點。購票成功終態由 `information-ready` 改為 `payment-ready`。

**Tech Stack:** TypeScript (strict)、Playwright、zod、React GUI、`node:test`、`node:assert/strict`、tsx。

**Spec:** `docs/ticketplus-flow-types-observation.md`（實站觀察與「使用者決定」一節）

## Global Constraints

- 四空白縮排、分號、`.js` 相對 import、`import type`；較長函式以簡短中文註解分段（AGENTS.md）。
- 流程類型值只有 `"purchase"`、`"lottery"`；舊設定沒有此欄位時視為 `"purchase"`，不改寫舊紀錄、不影響歷史指紋。
- 提醒彈窗白名單標題只有「實名抽選制售票提醒」「入場規定」，只按該彈窗內唯一可見啟用的「確定」，每次頁面載入最多一次；永不按「回到首頁」。其他彈窗維持原本停止規則。
- 不讀步驟條：步驟條在 A 的 order 頁有載入中暫時內容，且 A 站席寫「選擇座位」卻沒有選位頁；頁面種類與購票／抽選一律由網址與內容標記判斷。
- 參加者姓名、證件號碼只在瀏覽器內轉成布林值，不得進入 Node、IPC、紀錄或錯誤訊息（頁面顯示的證件號碼未遮罩）。
- 抽選：不讀取、不保存、不填寫參加者資料；不採用自動偵測填完；勾條款與按下一步各最多一次、不重試；永不按「確認登記」或「取消登記」。
- TicketPlus 不比對聯絡人、不需要 `contact.local.json`。
- 購票：資料頁勾條款與按下一步各最多一次、不重試；永不按「前往付款」「取消購票」，不選付款方式或取票方式；不核對價格與幣別。
- Commit 原子化：每個 commit 只做一件事且測試在該 commit 通過；讀取、操作、串接分開提交，讀取與操作模組在串接 commit 前不改變執行行為；文件另行提交。
- 每個 commit 後：`npm run typecheck` 與該 commit 列出的相關測試；不在每個 commit 跑 `npm test`。
- 每個 task 最後一個 commit 後做一次子代理審查，範圍為該 task 全部 commit；確認的問題修正後重跑相關測試再進下一個 task。全部完成後跑一次 `npm test`，再做一次整體審查。

| Task | Commits | 審查重點 |
| --- | --- | --- |
| 1 | 1.1–1.2 | 品質、回歸 |
| 2 | 2.1–2.3 | 品質、回歸、套套邏輯 |
| 3 | 3.1–3.4 | 品質、回歸 |
| 4 | 4.1–4.4 | 品質、回歸、套套邏輯 |
| 5 | 5.1–5.3 | 品質、回歸、套套邏輯 |
| 6 | 6.1–6.2 | 品質、回歸、套套邏輯 |
| 7 | 7.1–7.4 | 品質、回歸 |

套套邏輯審查時提供 `docs/ticketplus-flow-types-observation.md`，比對 fixture 與實站結構。

## Review Focus

- 抽選活動被設成購票（或反之）：場次按鈕文字不符必須在點擊前停止（`flow-mismatch`），不可點「立即登記」走購票流程。
- 購票設定卻進到帶「參加者資訊」的 confirm 頁（按鈕文字未擋下的情況）：不可勾條款或按下一步，停止 `not-purchase-page`。
- 提醒彈窗按「確定」後同一次載入又出現：必須停止，不可第二次點擊。
- 使用者在 GUI 確認時編輯表單或「關閉表單」確認仍開著：必須停止，不勾條款、不按下一步。
- 抽選按下一步後頁面停在 confirm 或出現未知彈窗：回報 `unknown`，不重按下一步。
- 購票在資料頁按下一步後停留原頁或跳出彈窗：回報 `unknown`，不重勾、不重按，也不回頭重新選票。

另：confirmSeat 的座位列與 checkout 摘要列同為 `.row.py-2.py-md-3.no-gutters`，不可被判為 checkout（Commit 4.1 測試涵蓋）。

---

### Task 1: 活動設定加入流程類型

**Interfaces:**
- Produces: `export type TicketPlusFlowType = "purchase" | "lottery";`、`export function ticketPlusFlowType(settings: TicketPlusActivitySettings): TicketPlusFlowType`（欄位缺少回 `"purchase"`）。schema 新增 `flowType: z.enum(["purchase", "lottery"]).optional()`。

#### Commit 1.1 `feat(config): add TicketPlus flow type setting`

Files: `src/config/ticketPlusActivity.ts`；Test: `tests/ticketPlusSettings.test.ts`

- [ ] 測試：缺 `flowType` 的舊設定可解析且 `ticketPlusFlowType` 為 `"purchase"`；`"lottery"` 可解析；`"seated"` 被拒並回原錯誤訊息；解析結果不新增欄位（`"flowType" in parsed === false`）。
- [ ] 跑測試確認失敗；實作 schema、helper，`invalidSettings` 文案加入「流程類型」；測試與 typecheck 通過；commit。

#### Commit 1.2 `feat(gui): add TicketPlus flow type radios`

Files: `src/local/react/platforms/ticketplus/formModel.ts`、`ActivityEditor.tsx`、`ActivityList.tsx`；Test: `tests/ticketPlusForm.test.ts`、`tests/ticketPlus.gui.test.ts`

- [ ] 測試：「活動網址」欄位正下方有 `fieldset.feature-settings`，legend「購票流程」，內含 `label.check` 包住的 radio `#flowPurchase`「購票」與 `#flowLottery`「登記抽選」（同一 `name`），新活動預設購票；選抽選後另一個自動取消、存檔內容含 `flowType: "lottery"`；載入舊設定顯示購票；活動列表顯示類型。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

### Task 2: 自動關閉已知活動提醒彈窗

**Interfaces:**
- Produces: snapshot dialog 新增 `kind: "notice"` 與 `noticeTitle?: "實名抽選制售票提醒" | "入場規定"`。判定：路徑為 `/activity/`、彈窗第一個非空文字行完全等於白名單標題、可見啟用按鈕恰為「回到首頁」「確定」各一。
- Produces: `export async function dismissTicketPlusActivityNotice(page: Page, control: TicketPlusRunControl): Promise<"none" | "dismissed">`；失敗丟 `TicketPlusSessionError`，新 reason `"notice-dismiss-failed"`（加入 `SessionEntryReason`）。

#### Commit 2.1 `feat(ticketplus): classify known activity notices`

Files: `src/platforms/ticketplus/domSnapshot.ts`、`src/platforms/ticketplus/pageState.ts`；Create: `tests/fixtures/ticketplus/activityNotice.ts`；Test: `tests/ticketPlusActivityNotice.test.ts`、`tests/ticketPlusSession.test.ts`

- [ ] Fixture：依觀察的 `.v-dialog__content[role="dialog"] > .v-dialog.v-dialog--active.v-dialog--persistent` 結構，提供兩種標題、未知標題、按鈕缺漏、點後重現四種模式，並計數兩顆按鈕點擊次數。
- [ ] 測試：兩種標題讀成 `notice` 並帶正確 `noticeTitle`；未知標題、按鈕不齊仍為 `unknown`；order 路徑的同結構彈窗不算 notice；選場次遇 notice 仍與現況相同停止（`blocking-dialog`），0 點擊。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusActivityNotice`、`ticketPlusSession`、`ticketPlusPage`、`ticketPlusActivityLoading`、typecheck 通過；commit。

#### Commit 2.2 `feat(ticketplus): add activity notice dismissal`

Files: Create `src/platforms/ticketplus/activityNotice.ts`；Test: `tests/ticketPlusActivityNotice.test.ts`

- [ ] 測試：兩種標題各點「確定」1 次、「回到首頁」0 次、回 `"dismissed"`；無彈窗回 `"none"` 且 0 點擊；未知標題、按鈕不齊 0 點擊並丟 `notice-dismiss-failed`；點後同一載入重現 → 丟錯且總點擊 1。
- [ ] 跑測試確認失敗；實作：點擊前以同規則重新定位同一顆按鈕，點後等到 notice 消失（沿用 control 期限）；測試與 typecheck 通過；commit。

#### Commit 2.3 `feat(ticketplus): dismiss notices before session entry`

Files: `src/platforms/ticketplus/sessionSelection.ts`；Test: `tests/ticketPlusSession.test.ts`

- [ ] 測試：活動頁只有 notice 時先關閉再點場次，「確定」1 次、場次 1 次；重新載入後再出現可再關一次；notice 與未知彈窗並存 → 0 點擊停止。
- [ ] 跑測試確認失敗；實作：每次導覽／重載重設該次載入的點擊額度；跑 `ticketPlusSession`、`ticketPlusSaleWait`、typecheck 通過；commit。

### Task 3: 抽選場次按鈕與排隊文案

**Interfaces:**
- Consumes: Task 1 `TicketPlusFlowType`、`ticketPlusFlowType`。
- Produces: `SessionSelectionOptions` 新增 `flowType: TicketPlusFlowType`；`SessionEntryReason` 新增 `"flow-mismatch"`。購票只點「立即購買」、抽選只點「立即登記」。

#### Commit 3.1 `feat(ticketplus): read lottery session button`

Files: `src/platforms/ticketplus/activityPage.ts`；Test: `tests/ticketPlusPage.test.ts`

- [ ] 測試：「立即登記」列解析為 `saleState: "available"` 並保留按鈕文字；「立即購買」「尚未開賣」不變；其他文字仍 `incomplete-data`。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 3.2 `feat(ticketplus): match session button to flow type`

Files: `src/platforms/ticketplus/sessionSelection.ts`、`src/app/runTicketPlus.ts`（傳入 `ticketPlusFlowType(activity)`）；Test: `tests/ticketPlusSession.test.ts`、`tests/ticketPlusRunner.test.ts`

- [ ] 測試：抽選設定點「立即登記」1 次；購票設定遇「立即登記」、抽選設定遇「立即購買」皆 0 點擊並停止 `flow-mismatch`；runner 將設定的流程類型傳給選場次。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 3.3 `feat(ticketplus): recognize lottery queue text`

Files: `src/platforms/ticketplus/domSnapshot.ts`；Test: `tests/ticketPlusSubmission.test.ts`

- [ ] 測試：h3「排隊登記中 請稍候」算排隊、提交後等待不誤判 unknown；附加文字「若人數眾多可能需要較長等待時間」存在時仍算同一排隊；「排隊購票中 請稍候」行為不變。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusSubmission`、`ticketPlusCycle`、typecheck 通過；commit。

#### Commit 3.4 `test(ticketplus): cover lottery and seated confirm pages`

Files: Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusSubmission.test.ts`（若現有 reader 無法解析，改為 `fix(ticketplus): ...` 並一併修正 `informationPage.ts`／`domSnapshot.ts`）

- [ ] 測試：抽選「輸入資料」confirm 頁（含登記明細、參加者資訊、聯絡人、條款、取消登記、下一步）由 `parseInformationPage` 解析為 `information`，提交等待得 `information-ready`；A 的 confirm 頁（含選擇優惠 radio 與折扣碼輸入框）同樣解析成功。
- [ ] 跑測試；全部通過則直接 commit；有失敗則修正 reader 後 commit。

### Task 4: 確認選位結果頁（坐席）

**Interfaces:**
- Produces: `export interface SeatConfirmationPage extends PageIdentity { kind: "seat-confirmation"; seats: { area: string; position: string; ticketType: string }[]; nextEnabled: boolean }`；判定：路徑 `/confirmSeat/<eventId>/<sessionId>`、「確認選位結果」標題恰 1 個、每列 4 欄且前三欄非空、唯一 `button.nextBtn`「下一步」與「取消購票」、無彈窗／排隊／條款／聯絡人。
- Produces: `TicketPlusSubmissionResult` 新增 `outcome: "seat-confirmation"`，帶 `seats`。
- Produces: `export async function confirmTicketPlusSeats(page: Page, settings: TicketPlusSelection, session: VerifiedTicketPlusSession, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<TicketPlusSubmissionResult>`，預設 `timeoutMs: 15_000`；核對通過後按一次下一步，抵達同場次 confirm 資料頁回 `information-ready`；核對不符在點擊前回 `stopped`，reason `"seat-mismatch"`；點擊後未抵達回 `unknown`，reason `"seat-confirm-unconfirmed"`。

座位核對：列數等於 `settings.target.quantity`；每列「票區」完全等於目標票區名稱（票區面板版型的 `ticketType`）；位置只要求非空，不比對排號。

#### Commit 4.1 `feat(ticketplus): read seat confirmation page`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`seatResult: { headingCount: number; rows: { area: string; position: string; ticketType: string }[] }`，只讀「確認選位結果」區塊內的列）、`src/platforms/ticketplus/pageState.ts`、`src/platforms/ticketplus/readFailure.ts`（`RouteKind` 加 `"confirmSeat"`）；Create: `tests/fixtures/ticketplus/seatConfirmPage.ts`；Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusDomReadDiagnostic.test.ts`

- [ ] Fixture：依觀察結構（`.bg-tranparent-yellow`「確認選位結果」、表頭四欄、每座位一列 `.row.py-2.py-md-3.no-gutters`、取消購票、下一步）提供 1 列相符、票區不符、列數不符、位置空白、下一步後轉 confirm 資料頁、下一步後停留原頁六種模式，計數下一步與取消購票點擊。
- [ ] 測試：confirmSeat 解析為 `seat-confirmation` 而非 checkout；缺標題、兩個下一步、混入條款皆 `unknown`；網址為其他活動或場次時拒絕；診斷 routeKind 為 `confirmSeat`。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 4.2 `feat(ticketplus): accept seat confirmation after submission`

Files: `src/platforms/ticketplus/ticketSubmission.ts`、`src/platforms/ticketplus/submissionOutcome.ts`；Test: `tests/ticketPlusSubmission.test.ts`

- [ ] 測試：選票提交後轉到同場次 confirmSeat 得 `seat-confirmation`（不是 `unknown`），0 次額外點擊；轉到其他場次 confirmSeat 仍拒絕。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusSubmission`、`ticketPlusOutcome`、typecheck 通過；commit。

#### Commit 4.3 `feat(ticketplus): confirm seat assignment once`

Files: Create `src/platforms/ticketplus/seatConfirmation.ts`；Test: `tests/ticketPlusSeatConfirmation.test.ts`

- [ ] 測試：相符 → 下一步 1 次、得 `information-ready`；票區不符、列數不符、位置空白 → 0 點擊 `seat-mismatch`；停留原頁 → `unknown` 且下一步總點擊 1；任何情況「取消購票」0 點擊。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 4.4 `feat(ticketplus): confirm seats in purchase cycle`

Files: `src/platforms/ticketplus/purchaseCycle.ts`、`src/app/ticketPlusPresentation.ts`；Test: `tests/ticketPlusCycle.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：`seat-confirmation` 後只呼叫一次座位確認，其結果即本次結果；`seat-mismatch` 不換下一順位、不更新票數；兩則文案「選位結果與設定的票區或張數不符，已停止；座位仍在網站保留中，請自行取消或處理」「已確認選位，但未能確認抵達資料頁，請檢查瀏覽器，不會重試」。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusCycle`、`ticketPlusRounds`、`ticketPlusMessages`、typecheck 通過；commit。

### Task 5: 購票資料頁送出並停在付款頁

**Interfaces:**
- Consumes: `InformationPage`（`contactFields`、`termsChecked`、`nextEnabled`）、`VerifiedTicketPlusSession`、`TicketPlusRunControl`。
- Produces: `export type InformationSubmissionResult = { outcome: "payment-ready" } | { outcome: "stopped" | "unknown"; reason: InformationSubmissionReason };`，`InformationSubmissionReason = "not-purchase-page" | "contact-missing" | "terms-missing" | "next-unavailable" | "checkout-not-reached" | "time-limit" | "user-stopped"`。
- Produces: `export async function submitTicketPlusInformation(page: Page, session: VerifiedTicketPlusSession, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<InformationSubmissionResult>`，預設 `timeoutMs: 15_000`。
- Produces: 購票成功終態 `payment-ready`，沿用 `purchaseRuns.ts` 既有的 `"payment-ready"` 狀態（保留瀏覽器與占用）；`information-ready` 只保留給舊紀錄讀取。`TicketPlusStage` 新增 `"submitting-information"`。

呼叫時機：`runTicketPlusCycle` 新增參數 `flowType: TicketPlusFlowType`；只有 `"purchase"` 在取得 `information-ready`（含 Task 4 確認座位後）時呼叫一次 `submitTicketPlusInformation`，`"lottery"` 原樣回傳 `information-ready` 交給 Task 7。

送出前核對購票資料頁：同場次 `/confirm/` 路徑、`parseInformationPage` 為 `information`、頁面沒有「參加者資訊」區塊（有則停止，避免把抽選頁當購票）。抵達付款頁的判定只用：同場次 `/checkout/` 路徑、唯一可見「前往付款」按鈕、沒有「確認登記」按鈕、無彈窗或排隊。不解析摘要欄位（實站 A 的 checkout 摘要欄位未記錄，價格由使用者人工核對），不修改既有 `parseCheckoutPage`。

#### Commit 5.1 `feat(ticketplus): add information page submission`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`participantSectionCount: number`：可見「參加者資訊」標題數；`registerButtons: boolean[]`：可見「確認登記」按鈕是否啟用）；Create `src/platforms/ticketplus/informationSubmission.ts`、`tests/fixtures/ticketplus/informationSubmitPage.ts`；Test: `tests/ticketPlusInformationSubmission.test.ts`

- [ ] Fixture：依觀察的 confirm 結構（購票明細、選擇優惠、鎖定聯絡欄位、條款、取消購票、下一步；C／A 站席／A 坐席三種購票明細欄位）與 checkout 結構（取票方式、付款方式 radio 未勾、購票明細、上一步、前往付款）；模式含頁面帶「參加者資訊」、聯絡欄位缺值、條款已勾、下一步後停留、下一步後出現未知彈窗；計數條款、下一步、前往付款、取消購票點擊。
- [ ] 測試：三種 confirm 皆勾條款 1 次、下一步 1 次、得 `payment-ready`，「前往付款」「取消購票」0 點擊，付款方式 radio 仍未勾；條款已勾 → 勾選 0 次；聯絡欄位任一缺值 → 0 點擊 `contact-missing`；頁面帶「參加者資訊」→ 0 點擊 `not-purchase-page`；停留原頁或出現彈窗 → `unknown`、下一步總點擊 1。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 5.2 `feat(ticketplus): stop purchase runs at payment page`

Files: `src/platforms/ticketplus/purchaseCycle.ts`、`src/app/runTicketPlus.ts`、`src/local/ticketPlusWorker.ts`、`src/app/ticketPlusPresentation.ts`；Test: `tests/ticketPlusCycle.test.ts`、`tests/ticketPlusRunner.test.ts`、`tests/ticketPlusWorker.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：購票成功結果為 `payment-ready`，worker 寫入 `payment-ready`，文案「已到付款頁，請自行確認金額並付款」；資料頁 `unknown` 不重新選票、不換順位；抽選設定得 `information-ready` 且未呼叫送出。
- [ ] 跑測試確認失敗；實作；跑上列測試與 `ticketPlusRounds`、`ticketPlusDeadlineOutcome`、typecheck 通過；commit。

#### Commit 5.3 `docs(ticketplus): document payment-page stop`

Files: `docs/ticketplus-dom.md`（取代「不勾條款、不點資料頁下一步」）、`docs/gui-usage.md`

- [ ] 更新文件：購票停在付款頁，付款方式與「前往付款」由使用者操作；commit。

### Task 6: 抽選參加者核對與停止點（平台模組）

**Interfaces:**
- Consumes: `VerifiedTicketPlusSession`、`TicketPlusRunControl`。
- Produces: `export type LotteryCompletionResult = { outcome: "registration-ready" } | { outcome: "stopped" | "unknown"; reason: LotteryStopReason };`，`LotteryStopReason = "not-input-page" | "dialog-open" | "participant-count" | "participant-incomplete" | "terms-missing" | "next-unavailable" | "checkout-not-reached" | "time-limit" | "user-stopped"`。
- Produces: `export async function completeTicketPlusLottery(page: Page, session: VerifiedTicketPlusSession, quantity: number, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<LotteryCompletionResult>`，預設 `timeoutMs: 15_000`。

`filled` 判定（瀏覽器內）：`.row.applicant-info` 的 `.applicant-number` 沒有 `grey` class，且 `.row.pl-5` 第 2 格起至少一格有文字。只回傳布林值。

#### Commit 6.1 `feat(ticketplus): read lottery participant state`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`applicants: { filled: boolean }[]`；沿用 Commit 5.1 的 `participantSectionCount` 與 `registerButtons`）；Create `tests/fixtures/ticketplus/lotteryPages.ts`；Test: `tests/ticketPlusLotteryCompletion.test.ts`

- [ ] Fixture：依觀察建立 confirm「輸入資料」頁（登記明細、參加者資訊與參加者列、聯絡人、條款、取消登記、下一步）與 checkout 確認登記頁（登記明細、上一步、確認登記）；可設定已填列數、開啟編輯表單、關閉表單確認、下一步按後停留原頁。
- [ ] 測試：未填列 `filled: false`、已填列 `filled: true`、空白格不影響已填判定；snapshot 結果序列化後不含 fixture 的姓名與證件號碼字串；checkout 讀出一個啟用的「確認登記」。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 6.2 `feat(ticketplus): complete lottery up to registration confirm`

Files: Create `src/platforms/ticketplus/lotteryCompletion.ts`；Test: `tests/ticketPlusLotteryCompletion.test.ts`

- [ ] 測試：1 列已填 → 勾條款 1 次、下一步 1 次、`registration-ready`，「確認登記」「取消登記」0 點擊；條款已勾 → 勾選 0 次；列數 ≠ quantity、任一列未填、編輯表單或關閉確認開著、沒有「參加者資訊」區塊 → 0 點擊 `not-input-page`，其餘 → 0 點擊 `stopped`；下一步後未到 checkout → `unknown` 且下一步總點擊 1；結果物件不含個資字串。
- [ ] 跑測試確認失敗；實作：核對 → 勾條款（未勾才點）→ 確認下一步啟用 → 點一次 → 等同場次 `/checkout/`、唯一「確認登記」存在且沒有「前往付款」、無彈窗；測試與 typecheck 通過；commit。

### Task 7: 執行器、worker、API 與 GUI 人工確認

**Interfaces:**
- Consumes: Task 6 `completeTicketPlusLottery`。
- Produces: `TicketPlusStage` 新增 `"waiting-for-participants"`、`"completing-registration"`；`TicketPlusRunOptions` 新增 `waitForParticipants?: (confirmationId: string) => Promise<void>`（由 worker 注入，resolve 表示收到確認）。
- Produces: worker 收 `{ type: "confirm-ticketplus-participants", confirmationId }` 只接受一次、ID 須相符；snapshot 新增 `participantConfirmation?: { confirmationId: string }`；`POST /api/purchase/confirm-participants` body `{ runId, confirmationId }`，沿用 token／來源防護；執行狀態新增 `"registration-ready"`（終態，保留瀏覽器與占用，同 `payment-ready`）。

#### Commit 7.1 `feat(ticketplus): wait for participant confirmation`

Files: `src/app/runTicketPlus.ts`、`src/app/ticketPlusPresentation.ts`；Test: `tests/ticketPlusRunner.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：抽選到資料頁後發出 `waiting-for-participants`（帶 confirmationId）、未確認前 0 點擊，且不呼叫 Task 5 的購票資料頁送出；確認後呼叫 `completeTicketPlusLottery` 一次，得 `registration-ready`；等待中達全程期限或使用者停止 → `stopped`，不勾條款；購票流程不等待，結果為 `payment-ready`。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 7.2 `feat(local): relay participant confirmation`

Files: `src/local/ticketPlusWorker.ts`、`src/local/purchaseWorker.ts`、`src/local/purchaseRuns.ts`、`src/local/server.ts`；Test: `tests/ticketPlusWorker.test.ts`、`tests/ticketPlusApi.test.ts`

- [ ] 測試：錯 ID、重複、提早、流程結束後的確認皆拒絕且不轉送；正確確認轉送一次；snapshot 只在等待中提供 `participantConfirmation`；`registration-ready` 寫入紀錄並可關閉瀏覽器。
- [ ] 跑測試確認失敗；實作；跑上列測試與 `ticketPlusWorkerState`、`ticketPlusStopApi`、typecheck 通過；commit。

#### Commit 7.3 `feat(gui): add participants-ready confirmation`

Files: `src/local/react/platforms/ticketplus/PurchaseSummary.tsx`、`startPurchase.ts`；Test: `tests/ticketPlusStart.gui.test.ts`

- [ ] 測試：等待時顯示「請在購票瀏覽器填寫所有參加者，完成後按『參加者已填完』；網站倒數結束前須完成」與按鈕；按下後同頁不可重按；`registration-ready` 顯示「已停在確認登記前，請自行檢查並送出」。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 7.4 `docs(gui): document lottery flow`

Files: `docs/gui-usage.md`

- [ ] 補抽選操作說明（設定類型、填參加者、按已填完、停在確認登記前）；commit。

### 收尾

- [ ] 跑 `npm test` 一次，回報結果。
- [ ] 整體審查（最強模型），依結果修正並重跑相關測試。
- [ ] 實站驗證另由使用者授權進行。
