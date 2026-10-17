# TicketPlus 購票／抽選流程類型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依使用者選擇的流程類型（購票／抽選）執行 TicketPlus：自動關閉已知活動提醒彈窗、在活動頁以場次按鈕文字確認流程類型；購票在資料頁勾條款、按一次下一步，停在付款頁「前往付款」之前；抽選在使用者人工填完參加者並於 GUI 確認後，勾條款、按一次下一步，停在「確認登記」之前。

**Architecture:** 購票（演唱會 A、C）與抽選共用活動頁、選場次、選票、提交與排隊模組；一般購票有三種頁面順序（C 與 A 站席：order → confirm → checkout；A 坐席：order → confirmSeat → confirm → checkout），不另分 A／C 設定，由提交後實際到達的頁面決定是否核對座位。頁面判斷：網址決定頁面種類，同一次 DOM 快照的內容確認已載入完整並分辨購票或抽選（confirm：有無「參加者資訊」；checkout：「前往付款」或「確認登記」），不讀步驟條。購票成功終態由 `information-ready` 改為 `payment-ready`；抽選終態為新的 `registration-ready`。

**Tech Stack:** TypeScript (strict)、Playwright、zod、React GUI、`node:test`、`node:assert/strict`、tsx。

**Spec:** `docs/ticketplus-flow-types-observation.md`（實站觀察與「使用者決定」一節）

**Plan reviews:** 2026-10-17 可行性與回歸風險子代理審查，結果已併入本版（見各 commit 的檔案與測試清單）。

## Global Constraints

- 四空白縮排、分號、`.js` 相對 import、`import type`；較長函式以簡短中文註解分段（AGENTS.md）。
- 流程類型值只有 `"purchase"`、`"lottery"`；欄位缺少視為 `"purchase"`。存檔時 `"purchase"` 省略不寫（比照 Klook `normalizeActivity`），舊活動重新存檔的歷史指紋不變。
- 提醒彈窗白名單標題只有「實名抽選制售票提醒」「入場規定」，只按該彈窗內唯一可見啟用的「確定」，每次頁面載入（`goto`／`reload`）最多一次；永不按「回到首頁」。其他彈窗維持原本停止規則。
- 不讀步驟條：步驟條在 A 的 order 頁有載入中暫時內容，且 A 站席寫「選擇座位」卻沒有選位頁；頁面種類與購票／抽選一律由網址與內容標記判斷。
- 「參加者資訊」標記只計算頁面本體，排除彈窗內容（編輯表單標題也是「參加者資訊」）。
- 條款勾選一律點 checkbox 控制項本身，不點 label 文字（label 內含條款連結）；點一次後核對已勾選，不再點第二次。
- 參加者姓名、證件號碼只在瀏覽器內轉成布林值，不得進入 Node、IPC、紀錄或錯誤訊息（頁面顯示的證件號碼未遮罩）。
- 抽選：不讀取、不保存、不填寫參加者資料；不採用自動偵測填完；勾條款與按下一步各最多一次、不重試；永不按「確認登記」或「取消登記」。
- 抽選等待參加者確認的時間不計入最長執行時間；只由使用者按停止、或頁面離開該輸入資料頁（網站倒數結束、導頁、出現未知彈窗）結束等待。
- 購票：資料頁勾條款與按下一步各最多一次、不重試；永不按「前往付款」「取消購票」，不選付款方式或取票方式；不核對價格與幣別。
- 抵達資料頁後、點擊前的停止（期限、使用者停止、核對不符）一律回明確的 `stopped` 結果並說明「已保留在資料頁、未送出」，不得經由例外變成 `unknown`；只有點擊後無法確認結果才是 `unknown`。
- TicketPlus 不比對聯絡人、不需要 `contact.local.json`。
- Commit 原子化：每個 commit 只做一件事且 typecheck 與列出的測試在該 commit 通過；讀取、操作、串接分開提交，讀取與操作模組在串接 commit 前不改變執行行為；新增 union 成員的 commit 同時更新所有 exhaustive 使用處（如 `Record<SessionEntryReason, string>`）；文件另行提交。
- 每個 commit 後：`npm run typecheck` 與該 commit 列出的相關測試；不在每個 commit 跑 `npm test`。
- 審查採分級制，每次審查由一位子代理同時檢查三項並分段回報：commit 品質（可讀性、單一責任、相容性）、回歸風險、測試套套邏輯（fixture 是否與實站結構相符）。
  - 會點擊或改變實際行為的 commit：commit 後逐筆審查，模型 Sonnet。
  - 只讀取、只接受新狀態、純 GUI 的 commit：不逐筆審查，併入 task 結束審查。
  - 文件 commit：不審查。
  - 每個 task 最後一個 commit 後做一次 task 審查，範圍為該 task 全部 commit，模型 Opus。
  - 全部完成後跑一次 `npm test`，再做一次整體審查，模型 Opus。
  - 有新增或修改 fixture 的 commit，其所屬審查（逐筆或 task）必附 `docs/ticketplus-flow-types-observation.md` 供比對。
  - 確認的問題修正後重跑相關測試，再進下一個 commit 或 task。

| Task | Commits | 逐筆審查（Sonnet） | task 審查（Opus） | 含 fixture |
| --- | --- | --- | --- | --- |
| 1 | 1.1–1.3 | — | 1.1–1.3 | — |
| 2 | 2.1–2.4 | 2.3、2.4 | 2.1–2.4 | 2.1 |
| 3 | 3.1–3.4 | 3.2、3.3 | 3.1–3.4 | — |
| 4 | 4.1–4.3 | 4.2、4.3 | 4.1–4.3 | 4.1 |
| 5 | 5.1–5.4 | 5.1、5.3 | 5.1–5.4 | 5.1 |
| 6 | 6.1–6.2 | 6.2 | 6.1–6.2 | 6.1 |
| 7 | 7.1–7.5 | 7.2、7.3 | 7.1–7.5 | — |

共 11 次逐筆審查、7 次 task 審查、1 次整體審查。

## Review Focus

- 抽選活動被設成購票（或反之）：場次按鈕文字不符必須在點擊前停止（`flow-mismatch`），不可點「立即登記」走購票流程。
- 購票設定卻進到帶「參加者資訊」的 confirm 頁：不可勾條款或按下一步，停止 `not-purchase-page`。
- 提醒彈窗在開賣前重載後、或選場次等待中才出現：每次載入可關一次；同一次載入關後又出現必須停止。
- 使用者在 GUI 確認時編輯表單或「關閉表單」確認仍開著：停止 `dialog-open`，不勾條款、不按下一步。
- 購票或抽選在資料頁按下一步後停留原頁或跳出彈窗：回報 `unknown`，不重勾、不重按，也不回頭重新選票。
- confirmSeat 的票區文字與票區面板標題格式不同時會 `seat-mismatch` 停止（安全方向）；不放寬比對。

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

Files: `src/local/react/platforms/ticketplus/formModel.ts`（表單欄位、存檔時 `"purchase"` 省略、`draftFingerprint` 納入流程類型）、`ActivityEditor.tsx`、`ActivityList.tsx`；Test: `tests/ticketPlusForm.test.ts`、`tests/ticketPlus.gui.test.ts`

- [ ] 測試：「活動網址」欄位正下方有 `fieldset.feature-settings`，legend「購票流程」，內含 `label.check` 包住的 radio `#flowPurchase`「購票」與 `#flowLottery`「登記抽選」（同一 `name`），新活動預設購票；選抽選後另一個自動取消、存檔內容含 `flowType: "lottery"`；選購票存檔內容不含 `flowType`；切換單選後顯示有未儲存變更；載入舊設定顯示購票；活動列表顯示類型。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 1.3 `feat(local): treat flow type as a run settings change`

Files: `src/local/purchaseRuns.ts`（舊版 v4 紀錄比較納入 `flowType`）；Test: `tests/ticketPlusStore.test.ts`、`tests/ticketPlusApi.test.ts`

- [ ] 測試：舊活動重新存為購票後，歷史紀錄仍為「已執行」；改為抽選後顯示「設定已更新」；v4 舊紀錄遇抽選設定視為設定變更。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

### Task 2: 自動關閉已知活動提醒彈窗

**Interfaces:**
- Produces: snapshot dialog 新增 `kind: "notice"` 與 `noticeTitle?: "實名抽選制售票提醒" | "入場規定"`。判定：路徑為 `/activity/`、彈窗第一個非空文字行完全等於白名單標題、可見啟用按鈕恰為「回到首頁」「確定」各一。
- Produces: `unknownPage` reason 新增 `"notice-dialog"`：活動頁只有 notice 彈窗時由 `classifyPage` 明確回傳，與 `blocking-dialog`、`conflicting-page` 區分。
- Produces: `export async function dismissTicketPlusActivityNotice(page: Page, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<"none" | "dismissed">`，預設 `timeoutMs: 5_000`（開賣前 control 沒有全程期限）；失敗丟 `TicketPlusNoticeError`，`reason: "notice-dismiss-failed"`。

#### Commit 2.1 `feat(ticketplus): classify known activity notices`

Files: `src/platforms/ticketplus/domSnapshot.ts`、`src/platforms/ticketplus/pageState.ts`（notice 明確分支與診斷欄位 `noticeDialogs`）、`src/platforms/ticketplus/readResult.ts`、`src/app/ticketPlusPresentation.ts`（若 reason 有對應文案表）；Create: `tests/fixtures/ticketplus/activityNotice.ts`；Test: `tests/ticketPlusActivityNotice.test.ts`、`tests/ticketPlusPage.test.ts`、`tests/ticketPlusSession.test.ts`

- [ ] Fixture：依觀察的 `.v-dialog__content[role="dialog"] > .v-dialog.v-dialog--active.v-dialog--persistent` 結構，提供兩種標題、未知標題、按鈕缺漏、點後重現、延遲出現五種模式，並計數兩顆按鈕點擊次數。
- [ ] 測試：兩種標題讀成 `notice` 並帶正確 `noticeTitle`；活動頁只有 notice 時 `classifyPage` 回 `notice-dialog`；未知標題、按鈕不齊仍為 `unknown` 彈窗與 `blocking-dialog`；order 路徑的同結構彈窗不算 notice；選場次遇 notice 仍停止、0 點擊（行為與現況相同）。確認既有 `blocking-dialog` 斷言（`ticketPlusSession.test.ts`、`ticketPlusPage.test.ts`、`ticketPlusSubmission.test.ts`）仍通過。
- [ ] 跑測試確認失敗；實作；跑上列測試與 `ticketPlusActivityLoading`、`ticketPlusLoginState`、typecheck 通過；commit。

#### Commit 2.2 `feat(ticketplus): add activity notice dismissal`

Files: Create `src/platforms/ticketplus/activityNotice.ts`；Test: `tests/ticketPlusActivityNotice.test.ts`

- [ ] 測試：兩種標題各點「確定」1 次、「回到首頁」0 次、回 `"dismissed"`；無彈窗回 `"none"` 且 0 點擊；未知標題、按鈕不齊 0 點擊並丟 `notice-dismiss-failed`；點後同一載入重現 → 丟錯且總點擊 1；超過 `timeoutMs` 未消失 → 丟錯。
- [ ] 跑測試確認失敗；實作：點擊前以同規則重新定位同一顆按鈕；測試與 typecheck 通過；commit。

#### Commit 2.3 `feat(ticketplus): dismiss notices after each page load`

Files: `src/app/runTicketPlus.ts`（`page.goto(eventUrl)` 後、登入判斷前呼叫）、`src/platforms/ticketplus/salePreparation.ts`（每次 `page.reload` 後、讀頁前呼叫）、`src/app/ticketPlusPresentation.ts`（`notice-dismiss-failed` 文案）；Test: `tests/ticketPlusRunner.test.ts`、`tests/ticketPlusSalePreparation.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：開啟活動頁出現 notice → 「確定」1 次後繼續登入判斷；排程開賣每次重載出現 notice 各關 1 次並繼續讀頁；關閉失敗停止並顯示原因；無 notice 時 0 點擊、行為不變。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 2.4 `feat(ticketplus): handle late notices during session entry`

Files: `src/platforms/ticketplus/sessionSelection.ts`、`src/platforms/ticketplus/pageReadiness.ts`（activity readiness 遇 `notice-dialog` 回 pending 交由選場次處理，不直接停止）；Test: `tests/ticketPlusSession.test.ts`

- [ ] 測試：選場次等待中才出現的 notice（延遲模式）關閉 1 次後點場次；同一載入第二次出現 → 停止、總「確定」1 次；notice 與未知彈窗並存 → 0 點擊停止；點場次前一刻出現 notice 時先關閉，不把逾時報成 `after-click-attempt`。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusSession`、`ticketPlusSaleWait`、typecheck 通過；commit。

### Task 3: 抽選場次按鈕與排隊文案

**Interfaces:**
- Consumes: Task 1 `TicketPlusFlowType`、`ticketPlusFlowType`。
- Produces: `SessionSelectionOptions` 新增 `flowType?: TicketPlusFlowType`（預設 `"purchase"`，既有呼叫不需修改）；`SessionEntryReason` 新增 `"flow-mismatch"`。購票只點「立即購買」、抽選只點「立即登記」。

#### Commit 3.1 `feat(ticketplus): read lottery session button`

Files: `src/platforms/ticketplus/activityPage.ts`（含 `diagnoseActivityFields` 的已知按鈕文字）；Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusActivityFields.test.ts`

- [ ] 測試：「立即登記」列解析為 `saleState: "available"` 並保留按鈕文字；診斷視為已知按鈕；「立即購買」「尚未開賣」不變；其他文字仍 `incomplete-data`。活動頁載入佔位（`activityLoading.ts` 的「立即購買」）抽選版本未觀察，不修改。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 3.2 `feat(ticketplus): match session button to flow type`

Files: `src/platforms/ticketplus/sessionSelection.ts`、`src/app/runTicketPlus.ts`（傳入 `ticketPlusFlowType(activity)`）、`src/app/ticketPlusPresentation.ts`（`flow-mismatch` 文案；「立即購買」相關文案依流程類型改寫）；Test: `tests/ticketPlusSession.test.ts`、`tests/ticketPlusRunner.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：抽選設定點「立即登記」1 次；購票設定遇「立即登記」、抽選設定遇「立即購買」皆 0 點擊並停止 `flow-mismatch`；未傳 `flowType` 時行為與現況相同；runner 將設定的流程類型傳給選場次。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 3.3 `feat(ticketplus): recognize lottery queue text`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`queueCount` 與 dialog `queue` 分支兩處）、`src/platforms/ticketplus/ticketSubmission.ts`（排隊文字判斷）、`src/app/ticketPlusPresentation.ts`（排隊文案不寫死「購票」）；Test: `tests/ticketPlusSubmission.test.ts`

- [ ] 測試：h3「排隊登記中 請稍候」算排隊；同文字在 `.v-dialog` 內、且附加「若人數眾多可能需要較長等待時間」時 dialog 分類為 `queue` 而非 `unknown`；提交後等待不誤判 unknown；「排隊購票中 請稍候」行為不變。
- [ ] 跑測試確認失敗；實作；跑 `ticketPlusSubmission`、`ticketPlusCycle`、typecheck 通過；commit。

#### Commit 3.4 `test(ticketplus): cover lottery and seated confirm pages`

Files: Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusSubmission.test.ts`（若現有 reader 無法解析，改為 `fix(ticketplus): ...` 並一併修正 `informationPage.ts`／`domSnapshot.ts`）

- [ ] 測試：抽選「輸入資料」confirm 頁（含登記明細、參加者資訊、聯絡人、條款、取消登記、下一步）由 `parseInformationPage` 解析為 `information`，提交等待得 `information-ready`；A 的 confirm 頁（含選擇優惠 radio 與折扣碼輸入框）同樣解析成功。
- [ ] 跑測試；全部通過則直接 commit；有失敗則修正 reader 後 commit。

### Task 4: 確認選位結果頁（坐席）

**Interfaces:**
- Produces: `export interface SeatConfirmationPage extends PageIdentity { kind: "seat-confirmation"; seats: { area: string; position: string; ticketType: string }[]; nextEnabled: boolean }`；判定：路徑 `/confirmSeat/<eventId>/<sessionId>`、「確認選位結果」標題恰 1 個、每列 4 欄且前三欄非空、唯一 `button.nextBtn`「下一步」與「取消購票」、無彈窗／排隊／條款／聯絡人。
- Produces: `export type SeatConfirmationResult = { outcome: "confirmed"; information: InformationPage } | { outcome: "stopped" | "unknown"; reason: "seat-mismatch" | "seat-confirm-unconfirmed" | "time-limit" | "user-stopped" };`
- Produces: `export async function confirmTicketPlusSeats(page: Page, settings: TicketPlusSelection, session: VerifiedTicketPlusSession, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<SeatConfirmationResult>`，預設 `timeoutMs: 15_000`；核對不符在點擊前回 `stopped`；點擊後未抵達同場次 confirm 資料頁回 `unknown`。
- Produces: `SubmissionReason` 新增 `"seat-mismatch" | "seat-confirm-unconfirmed"`；串接後 `TicketPlusSubmissionResult` 由座位結果組成：`confirmed` → `information-ready`；`stopped` → outcome `stopped`、保留 `submitAttempted: true`（直接組結果，不經 `stoppedSubmissionResult`）；`unknown` → outcome `unknown`。

座位核對：列數等於 `settings.target.quantity`；每列「票區」完全等於目標票區名稱（票區面板版型的 `ticketType`）；位置只要求非空，不比對排號。

#### Commit 4.1 `feat(ticketplus): read seat confirmation page`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`seatResult: { headingCount: number; rows: { area: string; position: string; ticketType: string }[] }`，只讀「確認選位結果」區塊內的列）、`src/platforms/ticketplus/pageState.ts`（路徑規則、新 kind、診斷 `routeKind` 改用 `RouteKind`）、`src/platforms/ticketplus/readFailure.ts`（`RouteKind` 加 `"confirmSeat"`）；Create: `tests/fixtures/ticketplus/seatConfirmPage.ts`；Test: `tests/ticketPlusPage.test.ts`、`tests/ticketPlusDomReadDiagnostic.test.ts`、`tests/ticketPlusReadFailure.test.ts`

- [ ] Fixture：依觀察結構（`.bg-tranparent-yellow`「確認選位結果」、表頭四欄、每座位一列 `.row.py-2.py-md-3.no-gutters`、取消購票、下一步）提供 1 列相符、票區不符、列數不符、位置空白、下一步後轉 confirm 資料頁、下一步後停留原頁六種模式，計數下一步與取消購票點擊。
- [ ] 測試：confirmSeat 解析為 `seat-confirmation` 而非 checkout；缺標題、兩個下一步、混入條款皆 `unknown`；網址為其他活動或場次時拒絕；診斷 routeKind 為 `confirmSeat`。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 4.2 `feat(ticketplus): add seat confirmation step`

Files: Create `src/platforms/ticketplus/seatConfirmation.ts`；Test: `tests/ticketPlusSeatConfirmation.test.ts`

- [ ] 測試：相符 → 下一步 1 次、得 `confirmed`；票區不符、列數不符、位置空白 → 0 點擊 `seat-mismatch`；停留原頁 → `unknown`（`seat-confirm-unconfirmed`）且下一步總點擊 1；任何情況「取消購票」0 點擊。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 4.3 `feat(ticketplus): confirm seats after ticket submission`

Files: `src/platforms/ticketplus/ticketSubmission.ts`（`checkRoute` 接受同場次 confirmSeat；等待資料頁時遇 `seat-confirmation` 呼叫座位確認；`SubmissionReason` 擴充）、`src/platforms/ticketplus/pageReadiness.ts`（`informationReadiness` 路徑接受 confirmSeat）、`src/platforms/ticketplus/submissionOutcome.ts`、`src/app/ticketPlusPresentation.ts`；Test: `tests/ticketPlusSubmission.test.ts`、`tests/ticketPlusCycle.test.ts`、`tests/ticketPlusOutcome.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：選票提交後轉到同場次 confirmSeat → 座位確認 1 次 → `information-ready`；其他場次 confirmSeat 仍拒絕；`seat-mismatch` 結果為 `stopped` 且 `submitAttempted: true`，不換下一順位、不更新票數；`seat-confirm-unconfirmed` 為 `unknown`；文案「選位結果與設定的票區或張數不符，已停止；座位仍在網站保留中，請自行取消或處理」「已確認選位，但未能確認抵達資料頁，請檢查瀏覽器，不會重試」。
- [ ] 跑測試確認失敗；實作；跑上列測試與 `ticketPlusRounds`、typecheck 通過；commit。

### Task 5: 購票資料頁送出並停在付款頁

**Interfaces:**
- Consumes: `InformationPage`（`contactFields`、`termsChecked`、`nextEnabled`）、`VerifiedTicketPlusSession`、`TicketPlusRunControl`。
- Produces: `export async function checkTicketPlusTerms(page: Page, control: TicketPlusRunControl): Promise<void>`（點 checkbox 控制項一次並核對已勾；已勾則 0 點擊；失敗丟錯，不重點），供 Task 6 共用。
- Produces: `export type InformationSubmissionResult = { outcome: "payment-ready" } | { outcome: "stopped" | "unknown"; reason: InformationSubmissionReason };`，`InformationSubmissionReason = "not-purchase-page" | "contact-missing" | "terms-missing" | "terms-unchecked" | "next-unavailable" | "checkout-not-reached" | "time-limit" | "user-stopped"`。
- Produces: `export async function submitTicketPlusInformation(page: Page, session: VerifiedTicketPlusSession, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<InformationSubmissionResult>`，預設 `timeoutMs: 15_000`；點擊前的停止（含期限與使用者停止）回 `stopped`，不丟例外。
- Produces: `TicketPlusCycleResult` 新增 `{ outcome: "payment-ready"; progress; submissionAttempts }` 與 `{ outcome: "stopped" | "unknown"; reason: "information-stopped"; informationFailure: InformationSubmissionReason; progress; submissionAttempts }`；`TicketPlusStage` 新增 `"submitting-information"`。

呼叫時機：`runTicketPlusCycle` 以 `ticketPlusFlowType(input)` 取得流程類型（不另加參數）；只有 `"purchase"` 在取得 `information-ready`（含 Task 4 確認座位後）時呼叫一次 `submitTicketPlusInformation`，`"lottery"` 原樣回傳 `information-ready` 交給 Task 7。

送出前核對購票資料頁：同場次 `/confirm/` 路徑、`parseInformationPage` 為 `information`、頁面本體沒有「參加者資訊」區塊（有則停止，避免把抽選頁當購票）。抵達付款頁的判定只用：同場次 `/checkout/` 路徑、唯一可見「前往付款」按鈕、沒有「確認登記」按鈕、無彈窗或排隊。不解析摘要欄位、不修改既有 `parseCheckoutPage`（它要求「付款結帳」為 `checkedStep`，實站為 `currStep`）。

#### Commit 5.1 `feat(ticketplus): add information page submission`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`participantSectionCount: number`：頁面本體、排除彈窗內的「參加者資訊」標題數；`registerButtons: boolean[]`：可見「確認登記」按鈕是否啟用）；Create `src/platforms/ticketplus/informationSubmission.ts`、`tests/fixtures/ticketplus/informationSubmitPage.ts`；Test: `tests/ticketPlusInformationSubmission.test.ts`

- [ ] Fixture：依觀察的 confirm 結構（購票明細、選擇優惠、鎖定聯絡欄位、Vuetify 隱藏 input 的條款 checkbox 且 label 內含兩個條款連結、取消購票、下一步；C／A 站席／A 坐席三種購票明細欄位）與 checkout 結構（取票方式、付款方式 radio 未勾、購票明細、上一步、前往付款）；模式含頁面帶「參加者資訊」、聯絡欄位缺值、條款已勾、下一步後停留、下一步後出現未知彈窗；計數條款、條款連結導覽、下一步、前往付款、取消購票點擊。
- [ ] 測試：三種 confirm 皆勾條款 1 次、下一步 1 次、得 `payment-ready`，條款連結導覽 0 次，「前往付款」「取消購票」0 點擊，付款方式 radio 仍未勾；條款已勾 → 勾選 0 次；勾後仍未勾 → `terms-unchecked` 且不再點；聯絡欄位任一缺值 → 0 點擊 `contact-missing`；頁面帶「參加者資訊」→ 0 點擊 `not-purchase-page`；點擊前停止 → `stopped`；停留原頁或出現彈窗 → `unknown`、下一步總點擊 1。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 5.2 `feat(local): accept TicketPlus payment-ready results`

Files: `src/local/purchaseRuns.ts`（結果閘門與磁碟驗證接受 TicketPlus `payment-ready`）、`src/local/ticketPlusWorker.ts`（結果 union）、`src/local/purchaseEvents.ts`（stage enum 加 `submitting-information`）、`src/local/react/shared/runs/runPresentation.ts`（TicketPlus `payment-ready` 文案）；Test: `tests/ticketPlusWorkerState.test.ts`、`tests/ticketPlusApi.test.ts`、`tests/ticketPlusWorker.test.ts`

- [ ] 測試：TicketPlus worker 回 `payment-ready` → 紀錄狀態為 `payment-ready`、可關閉瀏覽器、GUI 顯示「已到付款頁，請自行確認金額並付款」；`submitting-information` 事件被接受；Klook `payment-ready` 與 TicketPlus 舊 `information-ready` 紀錄行為不變。此 commit runner 尚不產生 `payment-ready`，執行行為不變。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 5.3 `feat(ticketplus): stop purchase runs at payment page`

Files: `src/platforms/ticketplus/purchaseCycle.ts`、`src/app/runTicketPlus.ts`、`src/app/ticketPlusPresentation.ts`；更新既有 fixture 加入 checkout 路由與斷言：`tests/ticketPlusApi.test.ts`、`ticketPlusSaleApi`、`ticketPlusLoginApi`、`ticketPlusStopApi`、`ticketPlusStart.gui`、`ticketPlusLogin.gui`、`ticketPlusSchedule.gui`、`ticketPlusStop.gui`、`ticketPlusStop`、`ticketPlusDeadlineRunner`、`ticketPlusCompatibility`、`ticketPlusWorkerState`、`ticketPlusRounds`、`ticketPlusCycle`、`ticketPlusOutcome`、`ticketPlusRunner`、`ticketPlusMessages`

- [ ] 測試：購票成功結果為 `payment-ready`；資料頁點擊前期限到或使用者停止 → `stopped`（`information-stopped`），文案「已保留在資料頁、未送出」，不被改寫成 `unknown`；資料頁 `unknown` 不重新選票、不換順位；抽選設定得 `information-ready` 且未呼叫送出。
- [ ] 跑測試確認失敗；實作並更新上列既有測試的 fixture 與預期；全部通過、typecheck 通過；commit。

#### Commit 5.4 `docs(ticketplus): document payment-page stop`

Files: `docs/ticketplus-dom.md`（取代「不勾條款、不點資料頁下一步」與「information-ready 不被期限覆寫」的相關敘述）、`docs/gui-usage.md`

- [ ] 更新文件：購票停在付款頁，付款方式與「前往付款」由使用者操作；commit。

### Task 6: 抽選參加者核對與停止點（平台模組）

**Interfaces:**
- Consumes: `VerifiedTicketPlusSession`、`TicketPlusRunControl`、Commit 5.1 的 `checkTicketPlusTerms`、`participantSectionCount`、`registerButtons`。
- Produces: `export type LotteryCompletionResult = { outcome: "registration-ready" } | { outcome: "stopped" | "unknown"; reason: LotteryStopReason };`，`LotteryStopReason = "not-input-page" | "dialog-open" | "participant-count" | "participant-incomplete" | "terms-missing" | "terms-unchecked" | "next-unavailable" | "checkout-not-reached" | "time-limit" | "user-stopped"`。
- Produces: `export function readTicketPlusLotteryInput(dom: TicketPlusDom, session: VerifiedTicketPlusSession): { kind: "input"; applicants: { filled: boolean }[] } | { kind: "other" }`（供 Task 7 等待期間判斷是否仍在同一輸入資料頁）。
- Produces: `export async function completeTicketPlusLottery(page: Page, session: VerifiedTicketPlusSession, quantity: number, control: TicketPlusRunControl, options?: { timeoutMs?: number }): Promise<LotteryCompletionResult>`，預設 `timeoutMs: 15_000`。

`filled` 判定（瀏覽器內）：`.row.applicant-info` 的 `.applicant-number` 沒有 `grey` class，且 `.row.pl-5` 第 2 格起至少一格有文字。只回傳布林值。

#### Commit 6.1 `feat(ticketplus): read lottery participant state`

Files: `src/platforms/ticketplus/domSnapshot.ts`（`applicants: { filled: boolean }[]`）；Create `src/platforms/ticketplus/lotteryInput.ts`（`readTicketPlusLotteryInput`）、`tests/fixtures/ticketplus/lotteryPages.ts`；Test: `tests/ticketPlusLotteryCompletion.test.ts`

- [ ] Fixture：依觀察建立 confirm「輸入資料」頁（登記明細、參加者資訊與參加者列、聯絡人、條款、取消登記、下一步）與 checkout 確認登記頁（登記明細、上一步、確認登記）；可設定已填列數、開啟編輯表單（標題也是「參加者資訊」）、關閉表單確認、下一步按後停留原頁、倒數結束導頁。
- [ ] 測試：未填列 `filled: false`、已填列 `filled: true`、空白格不影響已填判定；開啟編輯表單時 `participantSectionCount` 仍為 1；snapshot 結果序列化後不含 fixture 的姓名與證件號碼字串；離開輸入資料頁時回 `other`；checkout 讀出一個啟用的「確認登記」。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 6.2 `feat(ticketplus): complete lottery up to registration confirm`

Files: Create `src/platforms/ticketplus/lotteryCompletion.ts`；Test: `tests/ticketPlusLotteryCompletion.test.ts`

- [ ] 測試：1 列已填 → 勾條款 1 次、下一步 1 次、`registration-ready`，「確認登記」「取消登記」0 點擊、條款連結導覽 0 次；條款已勾 → 勾選 0 次。點擊前停止各回自己的 reason：沒有「參加者資訊」區塊 → `not-input-page`；編輯表單或關閉確認開著 → `dialog-open`；列數 ≠ quantity → `participant-count`；任一列未填 → `participant-incomplete`；下一步未啟用 → `next-unavailable`，以上皆 0 點擊。下一步後未到 checkout → `unknown`（`checkout-not-reached`）且下一步總點擊 1；結果物件不含個資字串。
- [ ] 跑測試確認失敗；實作：核對 → `checkTicketPlusTerms` → 確認下一步啟用 → 點一次 → 等同場次 `/checkout/`、唯一「確認登記」存在且沒有「前往付款」、無彈窗；測試與 typecheck 通過；commit。

### Task 7: 執行器、worker、API 與 GUI 人工確認

**Interfaces:**
- Consumes: Task 6 `completeTicketPlusLottery`、`readTicketPlusLotteryInput`。
- Produces: `TicketPlusRunControl` 新增 `excludeFromDeadline<T>(work: () => Promise<T>): Promise<T>`：期間暫停全程期限計時，結束後以剩餘時間繼續；使用者停止仍立即生效。
- Produces: `TicketPlusStage` 新增 `"waiting-for-participants"`、`"completing-registration"`；新事件 `{ type: "participants-wait"; confirmationId: string }`；`TicketPlusRunOptions` 新增 `waitForParticipants?: (confirmationId: string) => Promise<void>`（由 worker 注入，resolve 表示收到確認）。
- Produces: worker 收 `{ type: "confirm-ticketplus-participants", confirmationId }` 只接受一次、ID 須相符；snapshot 新增 `participantConfirmation?: { confirmationId: string }`；`POST /api/purchase/confirm-participants` body `{ runId, confirmationId }`，沿用既有 token／來源防護與 ID 驗證方式；執行狀態新增 `"registration-ready"`（終態，保留瀏覽器與占用，同 `payment-ready`）。既有停用的 `confirm-login` 不變。

等待期間：每秒讀一次頁面；`readTicketPlusLotteryInput` 回 `other`（網站倒數結束、導頁或未知彈窗）→ `stopped`，reason `"participant-page-changed"`；使用者停止 → `stopped`；兩者皆 0 點擊，文案說明「未送出登記」。

#### Commit 7.1 `feat(local): accept TicketPlus registration results`

Files: `src/local/purchaseRuns.ts`（結果閘門、磁碟驗證、snapshot 狀態型別接受 `registration-ready`）、`src/local/purchaseEvents.ts`（stage enum 加兩個新階段；新增 `participants-wait` 事件 schema）、`src/local/ticketPlusWorker.ts`（結果 union）、`src/local/react/shared/runs/runPresentation.ts`（`registration-ready` 與兩個新階段文案）；Test: `tests/ticketPlusWorkerState.test.ts`、`tests/ticketPlusApi.test.ts`、`tests/ticketPlusWorker.test.ts`

- [ ] 測試：`registration-ready` 寫入紀錄、可關閉瀏覽器、GUI 顯示「已停在確認登記前，請自行檢查並送出」；新階段與 `participants-wait` 事件被接受；其他狀態行為不變。此 commit runner 尚不產生這些事件。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 7.2 `feat(ticketplus): wait for participant confirmation`

Files: `src/platforms/ticketplus/runControl.ts`（`excludeFromDeadline`）、`src/app/runTicketPlus.ts`、`src/app/ticketPlusPresentation.ts`；Test: `tests/ticketPlusDeadlineControl.test.ts`、`tests/ticketPlusRunner.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試 control：`excludeFromDeadline` 期間不計入期限，結束後剩餘時間正確；期間使用者停止立即生效。
- [ ] 測試 runner：抽選到資料頁後發出 `waiting-for-participants` 與 `participants-wait`（帶 confirmationId）、未確認前 0 點擊，且不呼叫購票資料頁送出；等待超過原全程期限仍持續等待；確認後呼叫 `completeTicketPlusLottery` 一次，得 `registration-ready`；頁面離開輸入資料頁 → `stopped`（`participant-page-changed`）；使用者停止 → `stopped`，皆不勾條款；購票流程不等待，結果為 `payment-ready`。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 7.3 `feat(local): relay participant confirmation`

Files: `src/local/ticketPlusWorker.ts`、`src/local/purchaseWorker.ts`、`src/local/purchaseRuns.ts`、`src/local/server.ts`；Test: `tests/ticketPlusWorker.test.ts`、`tests/ticketPlusApi.test.ts`

- [ ] 測試：錯 ID、重複、提早、流程結束後的確認皆拒絕且不轉送；正確確認轉送一次；snapshot 只在等待中提供 `participantConfirmation`；token 或來源不符拒絕。
- [ ] 跑測試確認失敗；實作；跑上列測試與 `ticketPlusWorkerState`、`ticketPlusStopApi`、typecheck 通過；commit。

#### Commit 7.4 `feat(gui): add participants-ready confirmation`

Files: `src/local/react/platforms/ticketplus/PurchaseSummary.tsx`、`startPurchase.ts`；Test: `tests/ticketPlusStart.gui.test.ts`

- [ ] 測試：等待時顯示「請在購票瀏覽器填寫所有參加者，完成後按『參加者已填完』；網站倒數結束前須完成」與按鈕；按下後同頁不可重按；回應遺失不重送。
- [ ] 跑測試確認失敗；實作；測試與 typecheck 通過；commit。

#### Commit 7.5 `docs(gui): document lottery flow`

Files: `docs/gui-usage.md`

- [ ] 補抽選操作說明（設定類型、填參加者、按已填完、等待不計入最長執行時間、停在確認登記前）；commit。

### 收尾

- [ ] 跑 `npm test` 一次，回報結果。
- [ ] 整體審查（Opus），依結果修正並重跑相關測試。
- [ ] 實站驗證另由使用者授權進行。
