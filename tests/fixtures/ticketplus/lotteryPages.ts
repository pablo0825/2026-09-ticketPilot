import { eventHeader } from "./pages.js";

// 依 2026-10-17 抽選實站觀察重建：confirm「輸入資料」頁與 checkout 確認登記頁的最小 DOM。
// 已填列的姓名與證件號碼是假資料，用來確認讀取結果不會帶出這些文字。
export const fakeParticipant = { name: "王小明", id: "A123456789" };

// badge-only：徽章已非灰色但欄位空白；grey-text：仍為灰色徽章但欄位有字（兩者都不算已填）。
export type ParticipantRow = "empty" | "filled" | "badge-only" | "grey-text";
export type LotteryDialog = "edit" | "close-confirm";

function participantRow(row: ParticipantRow, index: number): string {
    const filled = row === "filled" || row === "badge-only";
    const cells =
        row === "filled" || row === "grey-text" ? [fakeParticipant.name, "", fakeParticipant.id] : ["", "", ""];
    return `<div class="row applicant-info mx-7">
    <div class="text-left d-flex px-0 px-md-4"><span class="applicant-number${filled ? "" : " grey lighten-1"}">${filled ? "" : index + 1}</span></div>
    <div class="text-left col-sm-9 col-md-9 col-9"><div class="row pl-5">
        <div class="text-left pl-0 col-sm-6 col-md-3">登記抽選(0${index + 1})</div>
        ${cells.map(cell => `<div class="text-left col-sm-6 col-md-3 col-6">${cell}</div>`).join("")}
    </div></div>
    <div class="text-right d-flex align-center justify-end"><div class="primary-1--text" role="button" data-lottery="edit"><span>編輯</span></div></div>
</div>`;
}

const dialogs: Record<LotteryDialog, string> = {
    edit: `<div class="v-dialog__content v-dialog__content--active" role="dialog"><div class="v-dialog v-dialog--active v-dialog--persistent">
        <div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">參加者資訊</div>
        <label for="nationality">國籍/地區</label><input id="nationality" type="text">
        <button type="button" disabled>完成</button></div></div>`,
    "close-confirm": `<div class="v-dialog__content v-dialog__content--active" role="dialog"><div class="v-dialog v-dialog--active">
        <div>關閉表單</div><div>您尚未完成資料填寫，關閉後將無法儲存資料，確認關閉表單？</div>
        <button type="button">取消</button><button type="button">確定</button></div></div>`,
};

export interface LotteryInputOptions {
    rows?: ParticipantRow[];
    dialog?: LotteryDialog;
    termsChecked?: boolean;
}

export function lotteryInputPage(options: LotteryInputOptions = {}): string {
    const rows = options.rows ?? ["filled"];
    const checked = options.termsChecked ?? false;
    return `${eventHeader}
<div>請在 5:02 完成填寫資料並確認登記內容</div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">登記明細</div>
<div><div>3880區~800區皆可</div><div>登記抽選</div><div>${rows.length}</div><div>NT. 0</div><div>NT. 0</div></div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">參加者資訊</div>
${rows.map(participantRow).join("")}
<p>※ 請填寫每位參加者之必填欄位。</p>
<h4>聯絡人資訊</h4>
<label for="contact-name">姓名</label><input id="contact-name" value="測*名" disabled>
<label for="contact-phone">phone_field</label><input id="contact-phone" value="0900***000" disabled>
<label for="contact-email">電子郵件</label><input id="contact-email" value="fi*****@example.invalid" disabled>
<div class="v-input v-input--selection-controls v-input--checkbox">
  <div class="v-input--selection-controls__input" data-lottery="terms" style="width:24px;height:24px">
    <input id="terms" type="checkbox" style="opacity:0;position:absolute;width:0;height:0"${checked ? " checked" : ""}>
  </div>
  <label for="terms">我已經閱讀並同意 <a href="/terms" data-lottery="link">會員服務條款</a> 與 <a href="/privacy" data-lottery="link">隱私權政策</a></label>
</div>
<button type="button" data-lottery="cancel">取消登記</button>
<button type="button" class="nextBtn" data-lottery="next"${checked ? "" : " disabled"}>下一步</button>
${options.dialog ? dialogs[options.dialog] : ""}`;
}

// 同時有前往付款：不能當成抽選確認登記頁。
export const mixedRegisterPage = `${eventHeader}
<button type="button" class="nextBtn" data-lottery="register">確認登記</button>
<button type="button" class="nextBtn" data-lottery="pay">前往付款</button>`;

export const registerPage = `${eventHeader}
<div>請在 4:36 完成填寫資料並確認登記內容</div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">登記明細</div>
<div class="row py-2 py-md-3 no-gutters"><div>3880區~800區皆可</div><div>登記抽選</div><div>1</div><div>NT. 0</div><div>NT. 0</div></div>
<button type="button" data-lottery="back">上一步</button>
<button type="button" class="nextBtn" data-lottery="register">確認登記</button>`;

export type LotteryNextMode = "to-register" | "stay";

// 計數各按鈕；條款切換並啟用下一步；下一步依模式轉到確認登記頁或停留。
export function lotteryBehavior(mode: LotteryNextMode, registerPath: string): string {
    return `<script>
    const bump = key => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
    document.addEventListener("click", event => {
        const target = event.target.closest("[data-lottery]");
        if (!target) return;
        const kind = target.dataset.lottery;
        bump("lottery-" + kind);
        if (kind === "link") event.preventDefault();
        if (kind === "terms") {
            const input = document.getElementById("terms");
            input.checked = !input.checked;
            document.querySelector('[data-lottery="next"]').disabled = !input.checked;
        }
        if (kind === "next" && ${JSON.stringify(mode)} === "to-register") location.assign(${JSON.stringify(registerPath)});
    });
</script>`;
}
