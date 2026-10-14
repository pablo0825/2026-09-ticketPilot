# TicketPlus 頁面資料、場次與張數選擇

唯讀入口是 `src/platforms/ticketplus/pageState.ts` 的 `readTicketPlusPage(page)`。
它回傳活動、選票、排隊、資料或付款頁的資料快照，或帶固定原因的 `unknown`。
不點擊、不輸入、不導航、不等待或重試，不比對購票設定，也不判定購票成功。
API、worker、runner、GUI、Klook 程式與 TicketPlus 啟動保護維持原樣。

## 證據來源與限制

來源是本次對話由使用者操作、助理唯讀觀察的單一活動，以及 2026-10-14 再次唯讀核對的活動／選票頁。
活動名稱為「2026孿生姐妹之夜之鬼迷心竅」，場次 2026-10-30 20:00。
活動 ID `0233a891800ffaa343bf8bff73d390e8`，場次 ID `62ecd68cb52728a63ac9cff43172e04f`。
這些是公開活動資訊，不是帳戶或訂單憑證。

`tests/fixtures/ticketplus/pages.ts` 是最小結構重建，不是下載的完整 HTML。
沒有加入網站不存在的票種 data-testid 或加減按鈕 aria-label。
多場次、同名票種、跨頁衝突、資料缺漏等是人工防禦案例，不是已觀察到的實站行為。

資料頁與付款頁本次沒有重新送出購票來復現；使用先前觀察的文字、角色與摘要結構。
資料頁 fixture 的 label/for 關聯重建已觀察的欄位名稱；原始動態 ID 不作選擇器。
付款頁的活動標頭沿用已核對的選票頁結構，仍需下一次實站唯讀複核。
若網站結構不同，reader 回 `unknown`；本機通過不能宣稱已支援所有活動。

## 已觀察的流程與定位依據

| 頁面 | 路徑 | DOM 依據與資料 |
| --- | --- | --- |
| 活動 | `/activity/<eventId>` | 唯一可見 h1；`.sesstion-item` 是網站實際拼字。每列有名稱、日期含星期、時間及「立即購買」button。頁面還有同名 tab，不能當成購票按鈕。沒有觀察到按鈕提供 session ID。 |
| 選票 | `/order/<eventId>/<sessionId>` | `.row.py-1.py-md-4.rwd-margin.no-gutters` 每列是一個票種；名稱是第一欄 `.font-weight-medium` 的直接文字。庫存 span 與價格 div 不屬於票名。 |
| 排隊 | 同上 | 可見 h3「排隊購票中 請稍候」。底層選票頁可能仍在，故 order 先判排隊。消失不代表進入 confirm，也不代表失敗。 |
| 資料 | `/confirm/<eventId>/<sessionId>` | 「聯絡人資訊」、姓名／phone_field／電子郵件欄位、條款 checkbox 與下一步。勾選前下一步停用；勾選後啟用。 |
| 付款 | `/checkout/<eventId>/<sessionId>` | `.stepText.checkedStep` 文字付款結帳；`.row.py-2.py-md-3.no-gutters` 摘要依序為票種、數量、票價、小計；前往付款 button。讀出所有摘要列，不只目標票種。 |

選票頁的活動資訊位於含 `.mdi-calendar` 的 `.text-page-title` 父容器；日期與時間分別在 calendar／clock-outline 圖示的同列兄弟欄位。
隱藏的響應式副本不讀；不把全頁第一個標題或任意日期當成場次資訊。

計數器 `.count-button` 內依序為 minus button、張數 div、plus button。
按鈕本身沒有文字名稱，內含 `aria-hidden` 的 `.mdi-minus`／`.mdi-plus` 圖示。
實作只在同一票種列讀取控制項，未來操作層可用 scoped getByRole("button") 搭配圖示 filter；不能假設 name="＋"。
唯讀快照採一次同步 `page.evaluate` 擷取 DOM，避免跨多次 locator await 混合資料；不模擬點擊。

觀察到學生票 0 張、預售票 1 張時，下一步啟用；這不能單獨證明選對票。
身障票顯示剩餘 0、已售完，且無計數器。
熱賣中沒有確切庫存；輸出 `remainingQuantity: null`，不可補成 0。
`saleStatus: selling` 只代表已辨識的網站文案，不保證有票；`canIncrease` 是獨立的按鈕狀態。
同名票種保留為多列，後續選擇器必須檢查是否唯一。

使用者按更新票數後曾觀察到預售票由 1 回到 0、學生票剩餘 15 變 14、下一步停用。
沒有取得穩定的刷新完成標記，也無法推論庫存減少原因。本階段不執行刷新、不加入順位或重試策略。

## 回傳契約

- 每份結果帶該頁網址讀出的 eventId；order、confirm、checkout 另帶 sessionId，不替换成設定值。
- 選票／付款成功快照必須有活動名稱、真實日期、合法時間與完整的所有票種列。
- 資料頁只回傳欄位 present／hasValue／disabled、條款與下一步狀態；缺聯絡欄位以 present=false 明確表示。kind=information 不代表資料已通過驗證。
- 姓名、電話、Email 的值在瀏覽器內轉成布林值，不回傳至 Node，不記錄 cookie、HTML 或原始 Playwright 錯誤。
- `unknown` 的原因包括 unsupported-url、page-changed、read-failed、conflicting-page、incomplete-data、ambiguous-data。這些都不是售完或最終失敗。
- `queue` 僅適用 order 路徑；checkout 出現排隊或其他頁面殘留標記視為衝突。
- 取得 URL 與 DOM 後再核對瀏覽器 URL；變動即拒絕。結果只代表取樣瞬間，不能保證未來點擊時仍有效，也不宣稱偵測所有同 URL 重繪。
- 不解釋未知 query/hash；目前只接受已觀察的無參數 HTTPS ticketplus.com.tw 路徑。

## 驗證與未涵蓋範圍

本機 Playwright 攔截路由供應 fixture，測試完整值、隱藏副本、重複控制項、錯誤網址、跨頁衝突、資料缺漏、售完與庫存區別，以及讀取前後零 click/submit/input/change 與表單值不變。
測試 expected 手寫，不呼叫正式 parser 產生答案，也不 mock reader。
保留既有 TicketPlus 設定與啟動保護測試。

未實作：登入判斷、更新票數、提交與排隊等待、條款勾選、個資正確性核對、付款核對成功判定、錯誤彈窗恢復、生命週期、API 啟動分流。
未確認：多場次實站版型、購買上限、排隊過期、其他活动實名／問卷／選位要求。

## 活動頁選擇場次

`src/platforms/ticketplus/sessionSelection.ts` 新增 `selectTicketPlusSession(page, settings, options)`。
使用現有 TicketPlus 設定，不新增場次名稱欄位，不修改 Klook、API、worker、runner、GUI 或啟動保護。
傳入的 Page 必須已由使用者手動登入並停在活動頁；此模組不開啟瀏覽器、不檢查 cookie、不代登入、不導航回起點。

流程：

1. 複製並驗證設定，讀取完整活動快照；核對活動 URL 的 eventId 及 eventName。
2. 日期與時間必須恰好對應一列，再檢查該列 buyEnabled。停用列也參與唯一性檢查。
3. 保留該列場次名稱作定位依據；它不是新的設定條件，不要求等於活動標題。
4. 以可見 `.sesstion-item` 的名稱、完整日期（可含星期）、時間限定目標，使用同列 `getByRole("button", { name: "立即購買", exact: true })`。不保留舊索引、不取 first、不 force click。
5. 點擊前重新讀取活動與場次唯一性，核對目標沒有變更；先標記已嘗試，再呼叫一次 click。
6. 固定期限內只讀取等待；完整選票快照的 eventId、eventName、日期與時間都符合才回傳。sessionId 是抵達後讀出的值，不宣稱事前已知。

`TicketPlusSessionError` 只含固定原因及 `before-click`／`after-click-attempt` 階段，不含原始 Playwright 錯誤、個資或頁面內容。
click 拋錯、導頁逾時或未知結果均不重新點擊，不改選其他場次。
「已嘗試」不表示事件一定送達，更不表示訂單已提交；沒有發出 Klook CONTACT_SUBMISSION。
本模組保證單次呼叫最多一次 click，跨呼叫防重複與 worker 狀態留給未來 runner。

預設 clickTimeoutMs=5000、arrivalTimeoutMs=15000、pollIntervalMs=100；選票抵達期限從 click 成功回傳後計算，不隨輪詢重設。
初始與點擊前讀取、按鈕 `isEnabled` 檢查各自以 clickTimeoutMs 為上限；並非整個函式共用一個總期限。
同活動尚未跳轉、頁面暫缺資料、換頁中的讀取失敗可在抵達期限內繼續唯讀觀察；已關閉頁面、錯站／活動網址、已知但不符的完整頁面立即停止。
遇到 queue、information、checkout 不繼續操作，不稱作售完。
沒有新增登入彈窗判讀；普通 click 遇到遮罩時會逾時並保守回報已嘗試，隱藏的殘留 dialog 不單獨視為未登入。

測試 `tests/ticketPlusSession.test.ts` 使用兩個固定目的地的場次：A 導 session-A／20:00、B 導 session-B／21:00，與測試目標設定無關。
按錯 A 不會由 fixture 提供 B 的正確答案。場次名稱 B 刻意與活動名稱不同並含正則特殊字元。
選票落地 fixture 所有張數為 0，獨立紀錄各場次、tab 及其他控制項的實際 click。
涵蓋重排、隱藏副本、同時間停用重複列、受控 DOM 變動、延遲導頁、不導頁、錯場次、未知頁與遮罩。
人工測試沒有證明多場次實站版型或完全消除重驗與 click 間的最後瞬間競態；接入正式流程前仍須實站驗證。


## 選擇票種與調整張數

`src/platforms/ticketplus/ticketQuantity.ts` 提供 `selectTicketPlusTickets(page, settings, verifiedSession, options)`。
`verifiedSession` 由上一階段回傳的選票頁快照提供 eventId、sessionId、eventName、date、time；不使用其中的舊票數。
設定與識別資料在入口複製並檢查是否一致。每次取樣都重新核對目前頁面身分、完整票種列與張數。
未接入正式 runner/API，不新增候補順位，不變更既有設定、Klook 或啟動保護。

票名採完整、大小寫與全半形敏感的相等比對，不摺疊內部空白；例如「Ａ區」不等於「A區」或「Ａ區 一般票」。
目標必須唯一，不能先排除售完／停用列再消除同名歧義。非目標票種若非零立即停止，不代清票。
加減按鈕仍用同列 `getByRole("button")` 配合 mdi-plus/minus；沒有 name="＋" 假設。
名稱欄含庫存與價格，因此候選列用 XPath 比對直接文字節點；引號透過 XPath literal 編碼，不將文字拼成可執行指令。
XPath 的空白正規化只協助候選定位，正式快照仍精確比對原票名；候選不唯一則停止。也將上次確認張數綁進 locator，避免舊索引／張數變動後改點另一列。
本版適用已觀察的單一直接票名文字節點；若網站把名稱拆成未知結構，停止而不改用模糊匹配。

調整規則：

- 起始 0、目標 2：固定方向為增加，最多嘗試兩次；每次必須確認精確 +1。
- 起始 3、目標 2：只需減號可用，加號停用不阻止減票。
- 起始已是 2：完整核對後零點擊回傳。
- 已確認 1 張卻又讀回 0：停止，不重新計算差額。
- 單擊由 0 跳到 2：停止，不當成完成，也不反向修正。
- 按完仍是原值：在單次確認期限內唯讀等待，不補按。缺資料、跳值、其他票種變動、錯場次、排隊或換頁都停止。
- 初始差額是本次 click 上限；方向、次數上限及總期限不因更新重設。
- 明確售完可停止；所需方向按鈕停用回 button-unavailable，不能稱售完。未知庫存／熱賣中不保證可加票，也不計算 target > remaining 或剩餘減已選。

`TicketPlusQuantityError` 包含固定的 reason、before-click／after-click-attempt、attemptedClicks、lastVerifiedQuantity。
嘗試次數在呼叫 click 前增加；此後任何失敗都保留已嘗試階段，不在每輪歸零。
最後確認張數不是錯誤發生當下的保證。例如先確認 1 張、第二下結果不明，保留最後確認 1 張及嘗試 2 次，交人工確認，不補按、不歸零、不刷新。
即使網站逾時後才更新，舊操作也不會追加點擊；不明結果後不能把再次呼叫包裝成安全自動重試。

預設整段 timeoutMs=30000、clickTimeoutMs=3000、changeTimeoutMs=3000、pollIntervalMs=100。
整段期限在設定驗證後開始，各次 click／確認等待均受剩餘總時間限制；不自行假定平台限購上限。
逾時的 DOM evaluate 可能仍在收尾，但只讀，不含後續點擊。重驗與 click 非原子操作，不能排除最後瞬間網站或人工變動。

成功回傳完整選票快照，僅表示當次核對通過；不代表預留成功或已購票。
nextEnabled 只回報觀察值，不取代票種與張數驗證。不按下一步、不更新票數、不執行候補或錯誤恢復。

測試 `tests/ticketPlusQuantity.test.ts` 配合 `tests/fixtures/ticketplus/quantityPage.ts` 使用各票種獨立的固定加減行為與 click 計數。
fixture 不取得 production target，expected 手寫，張數另以 fixture 的 textContent 讀取，不把正式 reader 當唯一裁判。
涵蓋 0/1/2/3→2、完整票名／引號／全形差異、隱藏副本／重排／新增同名列、停用方向、庫存文案、跳兩張、錯票更新、部分完成／總逾時、延遲 ack、歸零、換場次及排隊。
延遲 ack 測試會先觀察到至少一次等待讀取，才釋放第一個更新，並檢查 ack 前第二 click 不存在。
下一步與更新票數有獨立計數，應始終為零。
以上異常與多張數案例為本機防禦測試；未實站驗證限購、庫存含義、超額提示或延遲更新規則。
