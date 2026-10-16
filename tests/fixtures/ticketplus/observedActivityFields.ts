// 依 2026-10-16 唯讀觀測重建欄位關係；響應式標籤在寬版隱藏。
// 測試資料全部虛構；不新增正式程式依賴的測試定位屬性。
export const observedEventName = "2026孿生姐妹之夜之鬼迷心竅";
export const observedFieldStyle = `<style>
.d-block { display:block; }
@media(min-width:960px) { .d-md-none { display:none; } }
</style>`;

export function observedField(label: string, value: string): string {
    return `<div class="d-flex mb-2 mb-md-0"><div class="grey--text text--darken-1 d-block d-md-none mr-2 wordBreakKeepAll">${label}</div><div>${value}</div></div>`;
}

export const observedSpinner =
    '<div role="progressbar"><svg width="24" height="24"><circle cx="12" cy="12" r="10" /></svg></div>';
export const observedBuyButton = '<button type="button"><span>立即購買</span></button>';

export function observedActivity(
    options: { fields?: string; name?: string; button?: string; extra?: string } = {},
): string {
    return `${observedFieldStyle}<h1>${observedEventName}</h1><div class="sesstion-item">
<div class="name"><div class="font-weight-bold is-word-break">${options.name ?? observedEventName}</div></div>
${options.fields ?? observedField("日期", "2026-10-30(五)") + observedField("時間", "20:00")}
${options.extra ?? ""}<div class="button-area">${options.button ?? observedBuyButton}</div></div>`;
}

export function observedLoading(narrow: boolean): string {
    const date = narrow ? "2024-05-20(一) ~ 2024-12-31(二)" : "<div>2024-05-20(一)</div> ~ <div>2024-12-31(二)</div>";
    return observedActivity({
        name: "Loading...",
        fields: observedField("日期", date) + observedField("時間", "19:00 ~ 23:59"),
    });
}
