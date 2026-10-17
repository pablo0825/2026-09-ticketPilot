// 選票頁找票種列的規則，在瀏覽器內執行；讀取快照與點擊共用，確保兩邊認的是同一列。
// 函式內只用物件方法與行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。

export interface FoundTicketRow {
    row: Element;
    names: string[];
    // 票區面板版型中列所屬的票區名稱；票種列版型為 null。標題名稱無法唯一辨識時為空字串。
    area: string | null;
}

export interface FoundTicketArea {
    // 標題上的名稱候選；正常為一個。
    names: string[];
    // 標題上的庫存文字（剩餘 N、熱賣中…），已合併空白。
    stock: string[];
    expanded: boolean;
    // 收合後仍留在 DOM 的隱藏張數（曾展開過的票區），只用來檢查其他票種是否為零。
    hiddenQuantities: string[];
}

export interface TicketLayout {
    rows: FoundTicketRow[];
    areas: FoundTicketArea[];
}

// 只透過 withTicketRows 組進頁面函式使用，不直接在 Node 呼叫。
function findTicketLayout(): TicketLayout {
    const rules = {
        visible(element: Element): boolean {
            const style = getComputedStyle(element);
            return (
                element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse"
            );
        },
        all(root: ParentNode, selector: string): Element[] {
            return Array.from(root.querySelectorAll(selector)).filter(rules.visible);
        },
        directText(element: Element): string {
            return Array.from(element.childNodes)
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join("")
                .trim();
        },
        rowControls(root: Element): Element[] {
            // 列控制項：計數器，或沒有計數器時的售完／暫無票券文字。
            return [
                ...rules.all(root, ".count-button"),
                ...rules.all(root, "*").filter(element => ["已售完", "暫無票券"].includes(rules.directText(element))),
            ];
        },
        nameTexts(root: Element): string[] {
            // 名稱候選：可見直接文字，排除價格、庫存、售完、暫無票券與計數器張數。
            return rules
                .all(root, "*")
                .filter(element => !element.closest(".count-button"))
                .map(rules.directText)
                .filter(
                    value => value !== "" && !/^(剩餘\s*\d+|熱賣中|已售完|暫無票券|\d+|NT\.?\s*[\d,]+)$/.test(value),
                );
        },
        isPrice(element: Element): boolean {
            return (
                /^\s*NT\.?\s*[\d,]+\s*$/.test(element.textContent ?? "") &&
                !Array.from(element.children).some(rules.visible)
            );
        },
        areaHeader(panel: Element | null): Element | null {
            // 票區：標題上有價格的展開面板；其他用途的展開面板（例如說明）不算票區。
            const header = panel?.querySelector(":scope > .v-expansion-panel-header") ?? null;
            return header && rules.all(header, "*").some(rules.isPrice) ? header : null;
        },
        pricesInside(root: Element, prices: Element[]): number {
            return prices.filter(price => root.contains(price)).length;
        },
    };

    // 價格是每個票種列都有的元素（含售完列與更新空窗），用它找列，不依賴列的 class。
    // 票區標題上的價格屬於票區，不是票種列。
    const prices = rules
        .all(document.body, "*")
        .filter(
            element =>
                rules.isPrice(element) && !rules.areaHeader(element.closest(".v-expansion-panel"))?.contains(element),
        );

    // 列不可含其他價格；在此範圍內優先取第一個含計數器或售完文字的祖先，
    // 沒有時（例如更新空窗）取第一個含名稱的祖先。
    const rows = prices.map(price => {
        const chain: Element[] = [];
        let node = price.parentElement;
        while (node && node !== document.body && rules.pricesInside(node, prices) === 1) {
            chain.push(node);
            node = node.parentElement;
        }

        const withControl = chain.find(ancestor => rules.rowControls(ancestor).length > 0);
        const withName = chain.find(ancestor => rules.nameTexts(ancestor).length > 0);
        return withControl ?? withName ?? price;
    });
    const unique = rows.filter((row, index) => rows.indexOf(row) === index);

    // 不屬於任何列的計數器或售完文字代表有列沒被價格找到（例如價格格式不同），
    // 加入成為不完整列，讓整頁判為資料不完整，而不是默默少一列。
    const orphans = rules.rowControls(document.body).filter(control => !unique.some(row => row.contains(control)));

    // 票名：有名稱欄（票種列版型）時取名稱欄直接文字，否則取列內名稱候選。
    // 位於票區面板內的列，另外記下票區標題的名稱。
    const found = [...unique, ...orphans].map(row => {
        const labels = rules.all(row, ":scope > .font-weight-medium");
        const header = rules.areaHeader(row.closest(".v-expansion-panel"));
        const areaNames = header ? rules.nameTexts(header) : [];
        return {
            row,
            names: labels.length > 0 ? labels.map(rules.directText) : rules.nameTexts(row),
            area: header ? (areaNames.length === 1 ? areaNames[0]! : "") : null,
        };
    });

    // 票區面板：讀標題名稱、庫存文字與是否展開。
    const areas = rules
        .all(document.body, ".v-expansion-panel")
        .filter(panel => rules.areaHeader(panel) !== null)
        .map(panel => {
            const header = rules.areaHeader(panel);
            const expanded = header?.getAttribute("aria-expanded") === "true";
            return {
                names: header ? rules.nameTexts(header) : [],
                stock: header
                    ? rules
                          .all(header, "*")
                          .filter(element => !Array.from(element.children).some(rules.visible))
                          .map(element => rules.directText(element).replace(/\s+/g, " "))
                          .filter(value => /^(剩餘 \d+|熱賣中|已售完|暫無票券)$/.test(value))
                    : [],
                expanded,
                hiddenQuantities: expanded
                    ? []
                    : Array.from(panel.querySelectorAll(".v-expansion-panel-content .count-button > div")).map(
                          element => element.textContent?.trim() ?? "",
                      ),
            };
        });
    return { rows: found, areas };
}

// 為什麼要組合：page.evaluate 只把函式的原始碼送到瀏覽器執行，
// 所以頁面函式不能直接呼叫本模組的其他函式或變數。這裡把 findTicketLayout 的原始碼
// 一起組進去，並以第一個參數 findLayout 交給頁面函式；回傳的函式只收一個 arg，
// 呼叫端照常寫 page.evaluate(函式, arg)，測試也能照常攔截參數。
export function withTicketRows<Arg, Result>(
    pageFunction: (findLayout: () => TicketLayout, arg: Arg) => Result,
): (arg: Arg) => Result {
    return new Function("arg", `return (${pageFunction.toString()})(${findTicketLayout.toString()}, arg);`) as (
        arg: Arg,
    ) => Result;
}

export interface TargetRowQuery {
    ticketType: string;
    quantity: number;
}

// 點擊前用同一套找列規則定位目標列：票名完全相等、目前張數相符。
// candidates 必須為 1；加減按鈕各需在該列唯一的計數器內唯一，否則為 null，由呼叫端停止。
export const locateTargetRow = withTicketRows((findLayout, query: TargetRowQuery) => {
    // 可見性規則與 findTicketRows 相同：有版面且不是 visibility hidden／collapse。
    const seen = {
        visible(element: Element): boolean {
            const style = getComputedStyle(element);
            return (
                element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse"
            );
        },
    };

    // 找出票名與目前張數都相符的列。
    const matches = findLayout().rows.filter(
        found =>
            // 票種列版型比對票名；票區面板版型比對所屬票區（區內只會有一列，讀取時已檢查）。
            (found.area === null
                ? found.names.length === 1 && found.names[0] === query.ticketType
                : found.area === query.ticketType) &&
            Array.from(found.row.querySelectorAll(".count-button > div")).filter(
                element => seen.visible(element) && element.textContent?.trim() === String(query.quantity),
            ).length === 1,
    );

    // 取該列唯一可見計數器內的可見按鈕。
    const counters =
        matches.length === 1 ? Array.from(matches[0]!.row.querySelectorAll(".count-button")).filter(seen.visible) : [];
    const buttons =
        counters.length === 1 ? Array.from(counters[0]!.querySelectorAll("button")).filter(seen.visible) : [];
    const plus = buttons.filter(button => button.querySelector(".mdi-plus"));
    const minus = buttons.filter(button => button.querySelector(".mdi-minus"));

    // 回傳候選列數與唯一的加減按鈕。
    return {
        candidates: matches.length,
        plus: plus.length === 1 ? plus[0]! : null,
        minus: minus.length === 1 ? minus[0]! : null,
    };
});
