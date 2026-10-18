import { eventHeader } from "./pages.js";

// 依 2026-10-17 實站觀察重建：confirm 資料頁（C／A 站席／A 坐席）與 checkout 付款頁的最小 DOM。
// 條款為 Vuetify 隱藏 input，控制項在 .v-input--selection-controls__input；label 內含兩個條款連結。
export type DetailKind = "row" | "standing" | "seated";

const details: Record<DetailKind, string> = {
    row: '<div class="row py-2 py-md-3 no-gutters"><div>單人預售票</div><div>1</div><div>NT. 800</div><div>NT. 800</div></div>',
    standing:
        '<div class="row py-2 py-md-3 no-gutters"><div>一般票(站席)</div><div>全票</div><div>1</div><div>NT. 2,000</div><div>NT. 2,000</div></div>',
    seated: '<div class="row py-2 py-md-3 no-gutters"><div>C 區</div><div>25 排 7 號</div><div>預售票</div><div>NT. 5,800</div></div>',
};

export interface InformationOptions {
    detail?: DetailKind;
    participants?: boolean;
    contactMissing?: boolean;
    termsChecked?: boolean;
}

export function purchaseInformation(options: InformationOptions = {}): string {
    const name = options.contactMissing ? "" : "測*名";
    const participants = options.participants
        ? '<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">參加者資訊</div><div class="row applicant-info mx-7"></div>'
        : "";
    return `${eventHeader}
<div>請在 9:01 內完成購票手續並確認訂單</div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">購票明細</div>
${details[options.detail ?? "row"]}
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">選擇優惠</div>
<div class="v-input"><label for="discount-none">無</label><input id="discount-none" type="radio" name="discount" checked></div>
<button type="button" class="nextBtn" disabled>使用</button>
${participants}
<h4>聯絡人資訊</h4>
<label for="contact-name">姓名</label><input id="contact-name" value="${name}" disabled>
<label for="contact-phone">phone_field</label><input id="contact-phone" value="0900***000" disabled>
<label for="contact-email">電子郵件</label><input id="contact-email" value="fi*****@example.invalid" disabled>
<div class="v-input v-input--selection-controls v-input--checkbox">
  <div class="v-input--selection-controls__input" data-info="terms" style="width:24px;height:24px">
    <input id="terms" type="checkbox" style="opacity:0;position:absolute;width:0;height:0"${options.termsChecked ? " checked" : ""}>
    <div class="v-input--selection-controls__ripple"></div>
  </div>
  <label for="terms">我已經閱讀並同意 <a href="/terms" data-info="link">會員服務條款</a> 與 <a href="/privacy" data-info="link">隱私權政策</a></label>
</div>
<button type="button" data-info="cancel">取消購票</button>
<button type="button" class="nextBtn" data-info="next"${options.termsChecked ? "" : " disabled"}>下一步</button>`;
}

// 抽選的確認登記頁也在 /checkout；用來確認購票送出不會把它當成付款頁。
export const registerCheckout = `${eventHeader}
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">登記明細</div>
<button type="button" data-info="back">上一步</button>
<button type="button" class="nextBtn" data-info="register">確認登記</button>`;

export const purchaseCheckout = `${eventHeader}
<div>請在 9:02 內完成購票手續並確認訂單</div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">取票方式</div>
<div class="v-input"><label for="pickup">超商取票</label><input id="pickup" type="radio" name="pickup"></div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">付款方式</div>
<div class="v-input"><label for="pay-card">信用卡線上刷卡一次付清</label><input id="pay-card" type="radio" name="payment"></div>
<div class="v-input"><label for="pay-atm">ATM 虛擬帳號</label><input id="pay-atm" type="radio" name="payment"></div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">購票明細</div>
<div class="row py-2 py-md-3 no-gutters"><div>預售票</div><div>1</div><div>NT. 800</div><div>NT. 800</div></div>
<button type="button" data-info="back">上一步</button>
<button type="button" class="nextBtn" data-info="pay">前往付款</button>`;

export type NextMode = "to-checkout" | "stay" | "dialog" | "terms-inert" | "checkout-dialog";

// 計數各按鈕；點條款控制項切換勾選並啟用下一步；下一步依模式轉付款頁、停留或跳出未知彈窗。
export function informationBehavior(mode: NextMode, checkoutPath: string): string {
    return `<script>
    const bump = key => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
    document.addEventListener("click", event => {
        const target = event.target.closest("[data-info]");
        if (!target) return;
        const kind = target.dataset.info;
        bump("info-" + kind);
        if (kind === "link") event.preventDefault();
        if (kind === "terms" && ${JSON.stringify(mode)} !== "terms-inert") {
            const input = document.getElementById("terms");
            input.checked = !input.checked;
            document.querySelector('[data-info="next"]').disabled = !input.checked;
        }
        if (kind === "next" && ["to-checkout", "checkout-dialog"].includes(${JSON.stringify(mode)})) {
            location.assign(${JSON.stringify(checkoutPath)});
        }
        if (kind === "next" && ${JSON.stringify(mode)} === "dialog") {
            document.body.insertAdjacentHTML("beforeend", '<div class="v-dialog__content" role="dialog"><div class="v-dialog">未知提示<button>確定</button></div></div>');
        }
    });
    // checkout-dialog：付款頁載入後跳出未知彈窗
    if (${JSON.stringify(mode)} === "checkout-dialog" && location.pathname.startsWith("/checkout/")) {
        document.body.insertAdjacentHTML("beforeend", '<div class="v-dialog__content" role="dialog"><div class="v-dialog">未知提示<button>確定</button></div></div>');
    }
</script>`;
}

// 同時有前往付款與確認登記：不能當成購票付款頁。
export const mixedCheckout = `${eventHeader}
<button type="button" class="nextBtn" data-info="pay">前往付款</button>
<button type="button" class="nextBtn" data-info="register">確認登記</button>`;
