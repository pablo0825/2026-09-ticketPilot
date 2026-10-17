import { eventHeader } from "./pages.js";

// 票區面板版型，依 2026-10-17 實站觀察（LOOKMHEE 選票頁）重建的最小 DOM，不是完整網頁存檔。
// 收合票區沒有 content；曾展開後收合的票區 content 以 display:none 留在 DOM。

export const counter = (count = 0) =>
    `<div class="count-button ml-auto d-flex justify-space-between align-center">` +
    `<button type="button" class="v-btn grey-1"><span class="v-btn__content"><i aria-hidden="true" class="mdi mdi-minus"></i></span></button>` +
    `<div>${count}</div>` +
    `<button type="button" class="v-btn light-primary-2"><span class="v-btn__content"><i aria-hidden="true" class="mdi mdi-plus"></i></span></button>` +
    `</div>`;
export const unavailableText = '<span class="ml-1 disabled-text">暫無票券</span>';
// 票區版型實站只看過「暫無票券」；「已售完」是防禦案例，結構比照票種列版型的售完文字。
export const soldOutText = '<span class="ml-1 disabled-text">已售完</span>';
export const remaining = (value: number) =>
    `<small class="ml-1${value === 0 ? " soldout" : ""}">剩餘\n                ${value}</small>`;
export const selling = '<span class="v-chip v-chip--outlined"><span class="v-chip__content"> 熱賣中</span></span>';

export function ticketRow(name: string, price: string, control: string): string {
    // 實站沒有計數器的列（暫無票券）帶 soldout class。
    const closed = control.includes("count-button") ? "" : " soldout";
    return `<div class="row no-gutters${closed} text-title font-weight-regular">
  <div class="col col-8 text-title"><div><span>${name}</span><div class="ticket-price text-regular">NT. ${price}</div></div></div>
  <div class="text-right col col-4 align-self-center pl-3">${control}</div>
</div>`;
}

export interface AreaOptions {
    name: string;
    stock: string;
    price: string;
    // expanded：展開並顯示 rows；retained：收合但 content 仍以 display:none 留著；collapsed：從未展開。
    state: "expanded" | "retained" | "collapsed";
    rows?: string[];
}

export function area(options: AreaOptions): string {
    const expanded = options.state === "expanded";
    const content =
        options.state === "collapsed"
            ? ""
            : `<div class="v-expansion-panel-content"${expanded ? "" : ' style="display: none"'}><div class="v-expansion-panel-content__wrap">${(options.rows ?? []).join("")}</div></div>`;
    return `<div class="v-expansion-panel${expanded ? " v-expansion-panel--active v-item--active" : ""}">
  <button type="button" class="v-expansion-panel-header${expanded ? " v-expansion-panel-header--active" : ""}"${expanded ? ' aria-expanded="true"' : ""}>
    <div class="row no-gutters">
      <div class="d-flex align-center col col-8"><div class="area-color"></div><div class="d-flex align-center"> ${options.name} ${options.stock}</div></div>
      <div class="text-right col col-4">NT.${options.price}</div>
    </div>
  </button>${content}
</div>`;
}

export const vip = area({
    name: "VIP 區",
    stock: remaining(0),
    price: "8,900",
    state: "retained",
    rows: [ticketRow("預售票", "8,900", unavailableText)],
});
export const areaA = area({ name: "A 區", stock: remaining(1), price: "8,000", state: "collapsed" });
export const areaB = area({
    name: "B 區",
    stock: selling,
    price: "7,000",
    state: "expanded",
    rows: [ticketRow("預售票", "7,000", counter(0))],
});
export const areaC = area({ name: "C 區", stock: remaining(20), price: "5,800", state: "collapsed" });

export function areaOrder(panels: string[] = [vip, areaA, areaB, areaC]): string {
    return `${eventHeader}<div class="stepText currStep">選擇票種</div>
<div class="v-item-group theme--light v-expansion-panels seats-area">${panels.join("")}</div>
<button type="button">更新票數</button><button type="button">下一步</button>`;
}
