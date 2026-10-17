// 依 docs/ticketplus-dom.md 所列觀察重建的最小 DOM，不是完整網頁存檔。
// class、無名稱圖示按鈕和混合文字刻意保留；所有聯絡資料都是虛構測試值。
export const eventHeader = `
<div class="px-2 text-nine">
  <div class="mt-2 text-page-title text-sm-massive-title font-weight-bold">2026孿生姐妹之夜之鬼迷心竅</div>
  <div class="my-2 d-flex"><div><i class="mdi mdi-calendar"></i></div><div>2026-10-30</div></div>
  <div class="my-2 d-flex"><div><i class="mdi mdi-clock-outline"></i></div><div>20:00</div></div>
</div>`;

export const session = `
<div class="sesstion-item">
  <div class="row pa-4 flex-column flex-sm-row no-gutters">
    <div class="col-sm-10 col-md-10 col-12"><div class="row mx-0 flex-column flex-md-row no-gutters">
      <div class="d-flex text-left font-weight-bold text-regular py-2 is-word-break col-sm-12 col-md-4 col-12">2026孿生姐妹之夜之鬼迷心竅</div>
      <div class="col-sm-12 col-md-2 col-12"><div class="d-flex"><div class="wordBreakKeepAll">日期</div><div>2026-10-30(五)</div></div></div>
      <div class="col-sm-12 col-md-2 col-12"><div class="d-flex"><div class="wordBreakKeepAll">時間</div><div>20:00</div></div></div>
    </div></div>
    <div class="font-weight-bold col-sm-2 col-md-2 col-12"><button type="button"><span>立即購買</span></button></div>
  </div>
</div>`;

export const activity = `<h1 hidden>2026孿生姐妹之夜之鬼迷心竅</h1>
<h1>2026孿生姐妹之夜之鬼迷心竅</h1><div role="tab">立即購買</div>${session}`;

// 價格是列的獨立欄位，不在名稱欄內（2026-10-17 實站核對）。
export const student = `
<div class="row py-1 py-md-4 rwd-margin no-gutters">
  <div class="font-weight-medium py-3 col-sm-6 col-9 align-self-center">學生票
    <span class="v-tooltip"></span><span>剩餘 14</span>
  </div>
  <div class="text-center col-sm-3 col-3 align-self-center px-4 font-weight-bold">NT. 450</div>
  <div class="col-sm-3 col-3 align-self-center text-right"><div class="count-button d-flex">
    <button type="button" disabled><span><i aria-hidden="true" class="mdi mdi-minus"></i></span></button>
    <div>0</div>
    <button type="button"><span><i aria-hidden="true" class="mdi mdi-plus"></i></span></button>
  </div></div>
</div>`;

export const presale = `
<div class="row py-1 py-md-4 rwd-margin no-gutters">
  <div class="font-weight-medium py-3 col-sm-6 col-9 align-self-center">預售票
    <span class="v-tooltip"></span><span class="v-chip"><span class="v-chip__content">熱賣中</span></span>
  </div>
  <div class="text-center col-sm-3 col-3 align-self-center px-4 font-weight-bold">NT. 550</div>
  <div class="col-sm-3 col-3 align-self-center text-right"><div class="count-button d-flex">
    <button type="button"><span><i aria-hidden="true" class="mdi mdi-minus"></i></span></button>
    <div>1</div>
    <button type="button"><span><i aria-hidden="true" class="mdi mdi-plus"></i></span></button>
  </div></div>
</div>`;

export const soldOut = `
<div class="row py-1 py-md-4 rwd-margin no-gutters soldout">
  <div class="font-weight-medium py-3 col-sm-6 col-9 align-self-center">身障票
    <span class="v-tooltip"></span><span>剩餘 0</span>
  </div>
  <div class="text-center col-sm-3 col-3 align-self-center px-4 font-weight-bold">NT. 275</div><div class="col-sm-3 col-3 align-self-center text-right"><span>已售完</span></div>
</div>`;
export const order = `${eventHeader}<div class="stepText currStep">選擇票種</div>${student}${presale}${soldOut}
<button type="button">更新票數</button><button type="button">下一步</button>`;
export const queue = "<h3>排隊購票中<br>請稍候</h3>";
// 2026-10-17 抽選實站排隊文字；第二句是否在 h3 內未觀察，以兩種形式測試。
export const lotteryQueue = "<h3>排隊登記中<br>請稍候</h3><p>若人數眾多可能需要較長等待時間</p>";

// label/for 僅重建已觀察的 accessible name；動態 id 不作為正式定位條件。
export const information = `
<div>聯絡人資訊</div>
<label for="fixture-name">姓名</label><input id="fixture-name" value="測試姓名" disabled>
<label for="fixture-phone">phone_field</label><input id="fixture-phone" value="0900000000" disabled>
<label for="fixture-email">電子郵件</label><input id="fixture-email" value="fixture@example.invalid" disabled>
<label><input type="checkbox">使用 文化幣 折抵</label>
<label><input type="checkbox">我已經閱讀並同意 <a>會員服務條款</a> 與 <a>隱私權政策</a></label>
<button type="button" disabled>下一步</button>`;

// 2026-10-17 A 坐席 confirm 頁：購票明細含位置欄、選擇優惠 radio 與折扣碼，聯絡欄位鎖定遮罩。
export const seatedInformation = `
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">購票明細</div>
<div class="row py-2 py-md-3 no-gutters"><div>C 區</div><div>25 排 7 號</div><div>預售票</div><div>NT. 5,800</div></div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">選擇優惠</div>
<div class="v-input"><label for="fixture-discount-none">無</label><input id="fixture-discount-none" type="radio" name="discount" checked></div>
<div class="v-input"><label for="fixture-discount-code">促銷/優惠折扣碼</label><input id="fixture-discount-code" type="radio" name="discount"></div>
<div class="v-input"><label for="fixture-code">輸入折扣碼</label><input id="fixture-code" type="text"></div>
<button type="button" class="nextBtn" disabled>使用</button>
<h4>聯絡人資訊</h4>
<label for="fixture-name">姓名</label><input id="fixture-name" value="測*名" disabled>
<label for="fixture-phone">phone_field</label><input id="fixture-phone" value="0900***000" disabled>
<label for="fixture-email">電子郵件</label><input id="fixture-email" value="fi*****@example.invalid" disabled>
<label><input type="checkbox">我已經閱讀並同意 <a>會員服務條款</a> 與 <a>隱私權政策</a></label>
<button type="button">取消購票</button>
<button type="button" class="nextBtn" disabled>下一步</button>`;

// 2026-10-17 抽選「輸入資料」頁：登記明細、參加者資訊（未填）、鎖定聯絡人、條款、取消登記。
export const lotteryInput = `
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">登記明細</div>
<div><div>3880區~800區皆可</div><div>登記抽選</div><div>1</div><div>NT. 0</div><div>NT. 0</div></div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">參加者資訊</div>
<div class="row applicant-info mx-7">
    <div class="text-left d-flex px-0 px-md-4"><span class="applicant-number grey lighten-1">1</span></div>
    <div class="text-left col-sm-9 col-md-9 col-9"><div class="row pl-5">
        <div class="text-left pl-0 col-sm-6 col-md-3">登記抽選(01)</div>
        <div class="text-left col-sm-6 col-md-3 col-6"></div>
        <div class="text-left col-sm-6 col-md-3 col-6"></div>
        <div class="text-left col-sm-6 col-md-3 col-6"></div>
    </div></div>
    <div class="text-right d-flex align-center justify-end"><div class="primary-1--text" role="button"><span>編輯</span></div></div>
</div>
<p>※ 請填寫每位參加者之必填欄位。</p>
<h4>聯絡人資訊</h4>
<label for="fixture-name">姓名</label><input id="fixture-name" value="測*名" disabled>
<label for="fixture-phone">phone_field</label><input id="fixture-phone" value="0900***000" disabled>
<label for="fixture-email">電子郵件</label><input id="fixture-email" value="fi*****@example.invalid" disabled>
<label><input type="checkbox">我已經閱讀並同意 <a>會員服務條款</a> 與 <a>隱私權政策</a></label>
<button type="button">取消登記</button>
<button type="button" class="nextBtn" disabled>下一步</button>`;

export const summary =
    '<div class="row py-2 py-md-3 no-gutters"><div>預售票</div><div>1</div><div>550</div><div>550</div></div>';
// 付款頁摘要與步驟來自先前觀察；共用活動標頭結構需後續實站唯讀複核。
export const checkout = `${eventHeader}<div class="stepText checkedStep">付款結帳</div>${summary}
<div>取票方式</div><div>付款方式</div><button type="button">前往付款</button>`;
