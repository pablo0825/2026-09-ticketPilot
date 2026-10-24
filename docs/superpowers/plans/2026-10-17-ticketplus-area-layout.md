# TicketPlus 票區面板版型支援 Implementation Plan

> 本文件保留分階段觀察或設計歷史。現行操作請以 [README](../../../README.md) 為準；Klook 程式已保存在 `archive/klook` 分支。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 TicketPlus 選票流程同時支援票種列與票區面板兩種版型，並修正更新票數空窗判斷。

**Architecture:** 維持單次同步 `page.evaluate` 整頁快照。票種列改以價格錨點列舉、名稱精確比對挑選；票區面板以 Vuetify 元件 class 辨識。展開票區是獨立點擊模組，由順位挑選呼叫。

**Tech Stack:** TypeScript (strict)、Playwright、`node:test`、`node:assert/strict`、tsx。

**Spec:** `docs/superpowers/specs/2026-10-17-ticketplus-area-layout-design.md`

## Global Constraints

- 四空白縮排、分號、`.js` 相對 import、`import type`；步驟較多的函式以簡短中文註解分段（AGENTS.md）。
- 名稱完整相等比對：大小寫、全半形、內部空白敏感；0 個停止，多個停止。
- `暫無票券` 不得標成售完；使用者文案寫「已售完或暫無票券」。
- 讀取函式不得點擊；展開只點收合的目標票區一次；已展開不點。
- 每個 commit 後：`npm run typecheck`、相關測試，以及依風險分級的子代理審查（見下表）；通過後才 commit 下一個。
- 不核對價格與幣別。

| Task | 審查 |
| --- | --- |
| 1 | 品質、回歸、套套邏輯 |
| 2 | 品質、回歸 |
| 3 | 品質、回歸 |
| 4 | 品質、回歸、套套邏輯 |
| 5 | 品質 |
| 6 | 品質、套套邏輯 |
| 7 | 品質、套套邏輯 |

## Review Focus

- 刷新空窗期間售完列暫時出現計數器：不可被當成可購買，也不可讓 reader 判定為完整選票頁。
- 活動介紹或其他區塊含 `NT.` 價格文字：不可產生額外票種列（價格錨點限定在選票內容）。
- 付款摘要 `.row.py-2.py-md-3` 的價格欄：不可被當成票種列（付款頁仍判 checkout）。
- 票區收合後隱藏 content 內有非零張數：必須停止（extra-tickets）。
- 點已展開的目標票區：必須零點擊。

---

### Task 1: 刷新空窗接受保留的計數器

**Files:**
- Modify: `src/platforms/ticketplus/domSnapshot.ts`（監測 `dynamicGap` 條件）
- Modify: `src/platforms/ticketplus/refreshReadiness.ts`（`gap` 條件）
- Modify: `tests/fixtures/ticketplus/refreshPage.ts`（新增 `"live"` 模式）
- Test: `tests/ticketPlusRefreshCompletion.test.ts`

- [ ] 新增測試「實站形態：空窗保留計數器、售完列暫時出現計數器，仍可完成」，使用 `installRefreshExample(page, "live")`，斷言 `result.kind === "completed"`、`clicks.refresh === 1`、空窗中 `.count-button` 數量為 3。
- [ ] 新增測試「實站形態：空窗中計數器張數非零仍停止」。
- [ ] 跑測試確認新測試失敗（結果為 stopped）。
- [ ] `live` 模式：移除 `.font-weight-medium > span` 與 `已售完` span，保留計數器；售完列加入一組 0 張計數器；`restoreData` 還原原始 HTML。
- [ ] 兩處空窗條件改為：`statuses.length === 0 && soldOut === 0 && quantities.every(v => v === "0")`，名稱檢查不變；不再要求計數器與按鈕為零。
- [ ] 跑 `tests/ticketPlusRefresh*.test.ts`、`ticketPlusCycle`、`ticketPlusRounds` 全部通過，typecheck 通過。
- [ ] Commit `fix(ticketplus): accept counters during refresh gap`。

### Task 2: 以價格錨點找票種列（行為不變）

**Files:**
- Modify: `src/platforms/ticketplus/domSnapshot.ts`
- Test: `tests/ticketPlusPage.test.ts`

**Interfaces:**
- Produces: 快照 `tickets[]` 欄位不變（names、statuses、soldOut、counterCount、quantities、plus、minus）。

- [ ] 新增測試：票種列 class 改成任意 class 時仍讀出同樣三列；活動頁以外區塊的 `NT.` 文字不產生列；付款頁摘要不產生票種列。
- [ ] 確認失敗。
- [ ] 價格元素：可見、沒有可見子元素、文字符合 `/^NT\.?\s*[\d,]+$/`，且不在 `.row.py-2.py-md-3` 付款摘要內。列：從價格往上，取「只含這一個價格」的最外層祖先（不越過 `body`）。名稱：沿用列內 `.font-weight-medium` 直接文字讀法（Task 4 再泛化）。
- [ ] 全部 TicketPlus 測試通過，typecheck 通過。
- [ ] Commit `refactor(ticketplus): find ticket rows by price`。

### Task 3: 讀取與點擊共用目標比對與列定位

**Files:**
- Create: `src/platforms/ticketplus/ticketTarget.ts`
- Modify: `ticketPriority.ts`、`ticketQuantity.ts`、`submissionValidation.ts`、`ticketSubmission.ts`
- Test: `tests/ticketPlusQuantity.test.ts`、`tests/ticketPlusSubmission.test.ts`

**Interfaces:**
- Produces: `matchTargetTickets(tickets: TicketRow[], ticketType: string): TicketRow[]`；`markTargetRow(page, ticketType, count): Promise<number>`，在瀏覽器內用與 reader 相同的價格錨點規則標記唯一目標列（`data-ticket-pilot-target`），回傳候選數；呼叫端在數量不為 1 時停止，點擊後移除標記。

- [ ] 新增測試：票種列 class 不同時仍能加票與送出；同名兩列時零點擊停止。
- [ ] 實作並替換三處 `.row.py-1.py-md-4.rwd-margin.no-gutters` 與 `ticket.name === ticketType`。
- [ ] 全部 TicketPlus 測試通過，typecheck 通過。
- [ ] Commit `refactor(ticketplus): share ticket row matching for reads and clicks`。

### Task 4: 讀取票區面板版型

**Files:**
- Modify: `domSnapshot.ts`、`ticketSelectionPage.ts`、`ticketTarget.ts`
- Create: `tests/fixtures/ticketplus/areaPage.ts`
- Test: `tests/ticketPlusAreaPage.test.ts`

**Interfaces:**
- Produces: `TicketRow` 新增 `area: string | null`，`saleStatus` 增加 `"unavailable"`；`TicketSelectionPage` 新增 `areas: { name: string; remainingQuantity: number | null; expanded: boolean }[]`；`matchTargetTickets` 對票區版型以 `area === ticketType` 比對。

- [ ] fixture 依 spec 的實站結構：VIP（剩餘 0、已展開過收合、暫無票券）、A（剩餘 1）、B（熱賣中、展開、預售票 0 張）、C（剩餘 20）。
- [ ] 測試：讀出 5 個票區與 B 區預售票；暫無票券→`unavailable`；已售完→`sold-out`；標題剩餘 0＋計數器＋0 張→`unavailable`；＋1 張→`selling`；展開票區內兩列→`incomplete-data`；同頁混兩種版型→`incomplete-data`；隱藏 content 非零張數可被讀到。
- [ ] 實作。
- [ ] 全部 TicketPlus 測試通過，typecheck 通過。
- [ ] Commit `feat(ticketplus): read area-panel ticket layout`。

### Task 5: 跳過暫無票券順位

**Files:**
- Modify: `ticketPriority.ts`、`ticketQuantity.ts`、`src/app/ticketPlusPresentation.ts`
- Test: `tests/ticketPlusPriority.test.ts`、`tests/ticketPlusMessages.test.ts`

- [ ] 測試：順位 1 `unavailable` → 選順位 2；全部 `unavailable`/`sold-out` → `all-targets-sold-out`；文案含「已售完或暫無票券」；`ticketQuantity` 目標 `unavailable` → 新停止原因 `ticket-unavailable`。
- [ ] 實作、測試、typecheck。
- [ ] Commit `feat(ticketplus): skip unavailable priorities`。

### Task 6: 展開目標票區

**Files:**
- Create: `src/platforms/ticketplus/areaExpansion.ts`
- Modify: `ticketPriority.ts`
- Test: `tests/ticketPlusAreaExpansion.test.ts`

**Interfaces:**
- Produces: `expandTicketPlusArea(page: Page, areaName: string, deadline: number, control: TicketPlusRunControl): Promise<void>`，失敗拋 `TicketPlusPriorityError("area-expansion-failed")`。

- [ ] 測試：收合目標點一次後選票成功；已展開零點擊；展開逾時停止且只點一次；展開另一區會收合前一區的 fixture 下流程正確。
- [ ] 實作、測試、typecheck。
- [ ] Commit `feat(ticketplus): expand target area before selection`。

### Task 7: 票區版型刷新空窗與文件

**Files:**
- Modify: `domSnapshot.ts`、`refreshReadiness.ts`、`tests/fixtures/ticketplus/areaPage.ts`
- Modify: `docs/ticketplus-dom.md`、`docs/ticketplus-area-quantity-observation.md`
- Test: `tests/ticketPlusAreaRefresh.test.ts`

- [ ] 測試：票區標題庫存全部消失再恢復 → completed；只有部分票區消失 → 不完成。
- [ ] 實作：票區版型空窗以「所有票區標題無庫存文字且票區名稱集合不變」判斷。
- [ ] 測試、typecheck；文件補上實站觀察。
- [ ] Commit `feat(ticketplus): detect refresh gap in area layout` 與 `docs(ticketplus): record area-panel layout behavior`。
