import type { Page } from "playwright";

export interface SelectionOption {
    text: string;
    selected: boolean;
    disabled: boolean;
    soldOut: boolean;
    enabled: boolean;
}

export interface SelectionGroup {
    name: string;
    options: SelectionOption[];
}

export interface QuantityState {
    value: number | null;
    valueCount: number;
    limit: number | null;
}

export interface SelectionSnapshot {
    rootCount: number;
    loading: boolean;
    groups: SelectionGroup[];
    quantities: QuantityState[];
    adjacent: (boolean | null)[];
}

interface SelectionLayout {
    roots: Element[];
    loading: boolean;
    groups: { name: string; options: Element[] }[];
    quantities: {
        row: Element;
        value: Element | null;
        valueCount: number;
        plus: Element[];
        minus: Element[];
        limit: number | null;
    }[];
    adjacent: Element[];
}

// 在瀏覽器內找內容及其父層；讀取與後續操作共用，不保存列表索引。
// 使用物件方法，避免 tsx 在瀏覽器函式內加入 __name 輔助函式。
function findSelectionLayout(): SelectionLayout {
    const dom = {
        visible(element: Element): boolean {
            if (!element.getClientRects().length) return false;
            for (let node: Element | null = element; node; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (
                    style.display === "none" ||
                    style.visibility === "hidden" ||
                    style.visibility === "collapse" ||
                    style.opacity === "0"
                )
                    return false;
            }
            return true;
        },
        directText(element: Element): string {
            return Array.from(element.childNodes)
                .filter(node => node.nodeType === Node.TEXT_NODE)
                .map(node => node.textContent)
                .join("")
                .trim();
        },
        groupName(text: string): string | undefined {
            if (text === "日期" || text === "時間") return text;
            if (text === "票種" || text === "套餐類型") return "票種";
            const extra = /^(組合套票|取票方式)\s*(?:[（(][^()（）]*[）)])?$/.exec(text);
            return extra?.[1];
        },
    };
    // 已觀察的 ID 優先；沒有 ID 的版型以「票券選擇」標題的容器辨識。
    const identified = Array.from(document.querySelectorAll('[id="ticket-options"]')).filter(dom.visible);
    const headings = Array.from(document.querySelectorAll('h2, [role="heading"]')).filter(
        element => dom.visible(element) && element.textContent?.trim() === "票券選擇",
    );
    const roots = identified.length
        ? identified
        : headings.flatMap(heading =>
              heading.parentElement && !heading.parentElement.matches("body, html") ? [heading.parentElement] : [],
          );
    if (roots.length !== 1) return { roots, loading: false, groups: [], quantities: [], adjacent: [] };
    const root = roots[0]!;
    const loading = Array.from(root.querySelectorAll('.klk-loading, [aria-busy="true"]')).some(dom.visible);
    const groups = Array.from(root.querySelectorAll("*"))
        .filter(dom.visible)
        .flatMap(heading => {
            const name = dom.groupName(dom.directText(heading));
            const group = heading.parentElement;
            if (!name || !group || group === root || heading.children.length > 0) return [];
            const siblings = Array.from(group.children).filter(element => element !== heading && dom.visible(element));
            // 實站是標題旁的選項列表；舊版 fixture 也有選項直接放在標題旁的結構。
            const first = siblings[0];
            const directOptions =
                siblings.length > 0 &&
                siblings.every(element => element.matches('.spec-LwNjSh, [role="option"], [role="radio"]'));
            const options = directOptions
                ? siblings
                : siblings.length === 1 && first
                  ? Array.from(first.children).filter(dom.visible)
                  : [];
            return [{ name, options }];
        });
    // 從限購文字往上找含數量值的最小區塊，不使用外觀 class。
    const limits = Array.from(root.querySelectorAll("*")).filter(
        element => dom.visible(element) && /^最多\s*\d+\s*張$/.test(dom.directText(element)),
    );
    const quantities = limits.map(label => {
        let row = label;
        while (row.parentElement && row.parentElement !== root) {
            if (row.querySelector(".klk-icon-icon_other_plus_xs, .value-xWKzpL")) break;
            row = row.parentElement;
        }
        const plus = Array.from(row.querySelectorAll(".klk-icon-icon_other_plus_xs"))
            .filter(dom.visible)
            .flatMap(el => (el.parentElement ? [el.parentElement] : []));
        const minus = Array.from(row.querySelectorAll(".klk-icon-icon_other_minus_xs"))
            .filter(dom.visible)
            .flatMap(el => (el.parentElement ? [el.parentElement] : []));
        // 有加減鈕時，只讀同一個 counter 內的數字；控制項不齊的舊版保留已觀察的 value 標記。
        const counter =
            plus.length === 1 && minus.length === 1 && plus[0]!.parentElement === minus[0]!.parentElement
                ? plus[0]!.parentElement
                : null;
        const values = counter
            ? Array.from(counter.children).filter(
                  element => element !== plus[0] && element !== minus[0] && dom.visible(element),
              )
            : Array.from(row.querySelectorAll(".value-xWKzpL")).filter(dom.visible);
        return {
            row,
            value: values.length === 1 ? values[0]! : null,
            valueCount: values.length,
            plus,
            minus,
            limit: Number(dom.directText(label).match(/\d+/)?.[0]) || null,
        };
    });
    // 連位標籤可能在 checkbox 內，也可能在其外層；限定最小含 checkbox 的群組。
    const adjacent = new Set<Element>();
    for (const label of Array.from(root.querySelectorAll("*")).filter(
        element => dom.visible(element) && /相連座位/.test(dom.directText(element)),
    )) {
        let group: Element | null = label;
        while (group && group !== root) {
            const boxes = group.matches('[role="checkbox"]')
                ? [group]
                : Array.from(group.querySelectorAll('[role="checkbox"]'));
            if (boxes.length) {
                boxes.filter(dom.visible).forEach(box => adjacent.add(box));
                break;
            }
            group = group.parentElement;
        }
    }
    return { roots, loading, groups, quantities, adjacent: [...adjacent] };
}

// 與 TicketPlus 相同：將共用找群組函式一起送進 evaluate，不存取網站內部資料。
export function withSelectionLayout<Arg, Result>(
    read: (findLayout: () => SelectionLayout, arg: Arg) => Result,
): (arg: Arg) => Result {
    return new Function("arg", `return (${read.toString()})(${findSelectionLayout.toString()}, arg);`) as (
        arg: Arg,
    ) => Result;
}

const captureSelection = withSelectionLayout((findLayout): SelectionSnapshot => {
    const layout = findLayout();
    return {
        rootCount: layout.roots.length,
        loading: layout.loading,
        quantities: layout.quantities.map(quantity => ({
            value:
                quantity.value && /^\d+$/.test(quantity.value.textContent?.trim() ?? "")
                    ? Number(quantity.value.textContent?.trim())
                    : null,
            valueCount: quantity.valueCount,
            limit: quantity.limit,
        })),
        adjacent: layout.adjacent.map(element => {
            const inputs = element.querySelectorAll("input");
            const input = inputs[0];
            if (
                inputs.length !== 1 ||
                !(input instanceof HTMLInputElement) ||
                input.type !== "checkbox" ||
                input.indeterminate
            )
                return null;
            const aria = element.getAttribute("aria-checked");
            const consistent = input.checked ? aria === "true" : aria === null || aria === "false";
            return consistent ? input.checked : null;
        }),
        groups: layout.groups.map(group => ({
            name: group.name,
            options: group.options.map(element => ({
                text: element instanceof HTMLElement ? element.innerText.trim() : (element.textContent ?? "").trim(),
                selected: element.classList.contains("active-vB3nra"),
                disabled: element.classList.contains("disabled-ImixBj"),
                soldOut: element.classList.contains("soldout-sBHQQa"),
                enabled: !element.matches(':disabled, [aria-disabled="true"]'),
            })),
        })),
    };
});

export async function readSelectionDom(page: Page): Promise<SelectionSnapshot> {
    return page.evaluate(captureSelection);
}
