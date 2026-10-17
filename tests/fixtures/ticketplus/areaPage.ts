import type { Page } from "playwright";
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

export interface AccordionOptions {
    // 每個票區展開後要出現的票種列 HTML；收合票區一開始沒有 content。
    rows: Record<string, string>;
    // true：點了標題也不展開，用來測試展開逾時。
    ignoreHeaderClicks?: boolean;
    // 標題先標成展開，內容延遲這麼多毫秒才出現；實站畫出內容的時間未量測，用來確認程式會等待。
    contentDelayMs?: number;
}

// 依實站行為模擬手風琴：展開一個票區會收合目前展開的票區；收合後 content 以 display:none 留著。
// 同時記錄點擊：「展開:票區」與「票區+／票區-」，並讓加減按鈕改變張數。
export async function installAccordion(page: Page, options: AccordionOptions): Promise<void> {
    await page.evaluate(options => {
        const clicks: string[] = [];
        (window as unknown as { areaClicks: string[] }).areaClicks = clicks;
        // 用物件方法，避免 tsx 替瀏覽器內的箭頭函式加入 __name。
        const fixtureDom = {
            nameOf(panel: Element): string {
                return panel
                    .querySelector(".v-expansion-panel-header .d-flex.align-center .d-flex.align-center")!
                    .childNodes[0]!.textContent!.trim();
            },
        };

        document.addEventListener("click", event => {
            const target = event.target as Element;
            const panel = target.closest(".v-expansion-panel")!;
            const counterButton = target.closest(".count-button button");
            if (counterButton) {
                const delta = counterButton.querySelector(".mdi-plus") ? 1 : -1;
                clicks.push(`${fixtureDom.nameOf(panel)}${delta > 0 ? "+" : "-"}`);
                const count = counterButton.closest(".count-button")!.querySelector(":scope > div")!;
                count.textContent = String(Number(count.textContent) + delta);
                return;
            }
            const header = target.closest(".v-expansion-panel-header");
            if (!header) return;
            clicks.push(`展開:${fixtureDom.nameOf(panel)}`);
            if (options.ignoreHeaderClicks) return;

            // 收合其他票區，再展開被點的票區；已展開再點會收合。
            const wasExpanded = header.getAttribute("aria-expanded") === "true";
            for (const other of document.querySelectorAll(".v-expansion-panel")) {
                other.querySelector(":scope > .v-expansion-panel-header")!.removeAttribute("aria-expanded");
                const content = other.querySelector<HTMLElement>(":scope > .v-expansion-panel-content");
                if (content) content.style.display = "none";
            }
            if (wasExpanded) return;
            header.setAttribute("aria-expanded", "true");
            const name = fixtureDom.nameOf(panel);
            setTimeout(() => {
                let content = panel.querySelector<HTMLElement>(":scope > .v-expansion-panel-content");
                if (!content) {
                    panel.insertAdjacentHTML(
                        "beforeend",
                        `<div class="v-expansion-panel-content"><div class="v-expansion-panel-content__wrap">${options.rows[name] ?? ""}</div></div>`,
                    );
                    content = panel.querySelector<HTMLElement>(":scope > .v-expansion-panel-content")!;
                }
                content.style.display = "";
            }, options.contentDelayMs ?? 0);
        });
    }, options);
}

export const areaClicks = (page: Page) =>
    page.evaluate(() => (window as unknown as { areaClicks: string[] }).areaClicks);
