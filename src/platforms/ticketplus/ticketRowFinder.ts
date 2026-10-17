// 選票頁找票種列的規則，在瀏覽器內執行；讀取快照與點擊共用，確保兩邊認的是同一列。
// 函式內只用物件方法與行內 callback，避免 tsx 加入瀏覽器沒有的 __name 輔助函式。

export interface FoundTicketRow {
    row: Element;
    names: string[];
}

// 只透過 withTicketRows 組進頁面函式使用，不直接在 Node 呼叫。
function findTicketRows(): FoundTicketRow[] {
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
        hasNameText(root: Element, price: Element): boolean {
            // 名稱候選：價格以外、不是庫存／售完／張數的可見直接文字。
            return rules
                .all(root, "*")
                .some(
                    element =>
                        !price.contains(element) &&
                        rules.directText(element) !== "" &&
                        !/^(剩餘\s*\d+|熱賣中|已售完|暫無票券|\d+)$/.test(rules.directText(element)),
                );
        },
        pricesInside(root: Element, prices: Element[]): number {
            return prices.filter(price => root.contains(price)).length;
        },
    };

    // 價格是每個票種列都有的元素（含售完列與更新空窗），用它找列，不依賴列的 class。
    const prices = rules
        .all(document.body, "*")
        .filter(
            element =>
                /^\s*NT\.?\s*[\d,]+\s*$/.test(element.textContent ?? "") &&
                !Array.from(element.children).some(rules.visible),
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
        const withName = chain.find(ancestor => rules.hasNameText(ancestor, price));
        return withControl ?? withName ?? price;
    });
    const unique = rows.filter((row, index) => rows.indexOf(row) === index);

    // 不屬於任何列的計數器或售完文字代表有列沒被價格找到（例如價格格式不同），
    // 加入成為不完整列，讓整頁判為資料不完整，而不是默默少一列。
    const orphans = rules.rowControls(document.body).filter(control => !unique.some(row => row.contains(control)));

    // 票名是名稱欄的直接文字；不完整列沒有名稱欄，names 為空。
    return [...unique, ...orphans].map(row => ({
        row,
        names: rules.all(row, ":scope > .font-weight-medium").map(rules.directText),
    }));
}

// 為什麼要組合：page.evaluate 只把函式的原始碼送到瀏覽器執行，
// 所以頁面函式不能直接呼叫本模組的其他函式或變數。這裡把 findTicketRows 的原始碼
// 一起組進去，並以第一個參數 findRows 交給頁面函式；回傳的函式只收一個 arg，
// 呼叫端照常寫 page.evaluate(函式, arg)，測試也能照常攔截參數。
export function withTicketRows<Arg, Result>(
    pageFunction: (findRows: () => FoundTicketRow[], arg: Arg) => Result,
): (arg: Arg) => Result {
    return new Function("arg", `return (${pageFunction.toString()})(${findTicketRows.toString()}, arg);`) as (
        arg: Arg,
    ) => Result;
}

export interface TargetRowQuery {
    ticketType: string;
    quantity: number;
}

// 點擊前用同一套找列規則定位目標列：票名完全相等、目前張數相符。
// candidates 必須為 1；加減按鈕各需在該列唯一的計數器內唯一，否則為 null，由呼叫端停止。
export const locateTargetRow = withTicketRows((findRows, query: TargetRowQuery) => {
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
    const matches = findRows().filter(
        found =>
            found.names.length === 1 &&
            found.names[0] === query.ticketType &&
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
