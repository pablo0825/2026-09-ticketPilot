import type { Page } from "playwright";

// 同一次同步 DOM 讀取取得網址與欄位，避免跨 await 拼接不同畫面。
// 不回傳 input value、整頁文字、HTML 或原始錯誤。
export async function readTicketPlusDom(page: Page) {
    return page.evaluate(() => {
        // 使用物件方法，避免 tsx 替獨立箭頭函式加入無法序列化的名稱輔助函式。
        const dom = {
            visible(element: Element): boolean {
                const style = getComputedStyle(element);
                return (
                    element.getClientRects().length > 0 &&
                    style.visibility !== "hidden" &&
                    style.visibility !== "collapse"
                );
            },
            all(root: ParentNode, selector: string): Element[] {
                return Array.from(root.querySelectorAll(selector)).filter(dom.visible);
            },
            text(element: Element): string {
                return (element as HTMLElement).innerText.trim();
            },
            directText(element: Element): string {
                return Array.from(element.childNodes)
                    .filter(node => node.nodeType === Node.TEXT_NODE)
                    .map(node => node.textContent)
                    .join("")
                    .trim();
            },
            enabled(element: Element): boolean {
                return !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
            },
            buttons(root: ParentNode, name: string): boolean[] {
                return dom
                    .all(root, "button")
                    .filter(element => dom.text(element) === name)
                    .map(dom.enabled);
            },
            leafTexts(root: ParentNode): string[] {
                return dom
                    .all(root, "*")
                    .filter(element => !Array.from(element.children).some(dom.visible))
                    .map(dom.text);
            },
        };
        const { visible, all, text, directText, enabled, buttons, leafTexts } = dom;

        // 僅讀已觀察的流程標記，不把隱藏標題或空對話框當成排隊。
        const queueCount = all(document, 'h3, [role="heading"][aria-level="3"]').filter(
            element => text(element).replace(/\s+/g, " ") === "排隊購票中 請稍候",
        ).length;
        const sessions = all(document, ".sesstion-item");
        const ticketRows = all(document, ".row.py-1.py-md-4.rwd-margin.no-gutters");
        const summaryRows = all(document, ".row.py-2.py-md-3.no-gutters");
        const terms = all(document, 'input[type="checkbox"]').filter(element => {
            const input = element as HTMLInputElement;
            return Array.from(input.labels ?? []).some(label =>
                /^我已經閱讀並同意\s*會員服務條款\s*與\s*隱私權政策$/.test(text(label)),
            );
        });
        const checkoutSteps = all(document, ".stepText.checkedStep").filter(element => text(element) === "付款結帳");

        // 活動與場次只讀公開文字；資料頁不掃描整頁，避免帶出聯絡人值。
        const activity = sessions.map(row => ({
            names: all(row, ".font-weight-bold.is-word-break").map(text),
            dates: leafTexts(row).filter(value => /^\d{4}-\d{2}-\d{2}(?:\([一二三四五六日]\))?$/.test(value)),
            times: leafTexts(row).filter(value => /^\d{2}:\d{2}$/.test(value)),
            buyButtons: buttons(row, "立即購買"),
        }));
        const identities = all(document, ".text-page-title")
            .filter(element => element.parentElement && all(element.parentElement, ".mdi-calendar").length > 0)
            .map(element => {
                const root = element.parentElement!;
                const [dates, times] = [".mdi-calendar", ".mdi-clock-outline"].map(selector =>
                    all(root, selector).map(icon => {
                        const row = icon.parentElement?.parentElement;
                        return row
                            ? Array.from(row.children)
                                  .filter(visible)
                                  .filter(child => !child.contains(icon))
                                  .map(text)
                                  .join(" ")
                                  .trim()
                            : "";
                    }),
                );
                return { name: text(element), dates: dates!, times: times! };
            });

        // 每一票種列獨立讀取；保留重複票名，不合併或選第一筆。
        const tickets = ticketRows.map(row => {
            const labels = all(row, ":scope > .font-weight-medium");
            const counters = all(row, ".count-button");
            return {
                names: labels.map(directText),
                statuses: labels
                    .flatMap(label =>
                        Array.from(label.children)
                            .filter(visible)
                            .filter(child => child.tagName === "SPAN")
                            .map(text),
                    )
                    .filter(Boolean),
                soldOut: leafTexts(row).filter(value => value === "已售完").length,
                counterCount: counters.length,
                quantities: counters.flatMap(counter => all(counter, ":scope > div").map(text)),
                plus: all(row, "button")
                    .filter(button => button.querySelector(".mdi-plus"))
                    .map(enabled),
                minus: all(row, "button")
                    .filter(button => button.querySelector(".mdi-minus"))
                    .map(enabled),
            };
        });

        // 個資在瀏覽器內轉成布林值，絕不將原始值帶回執行程序。
        const contact = ["姓名", "phone_field", "電子郵件"].map(label =>
            all(document, 'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')
                .filter(element =>
                    Array.from((element as HTMLInputElement).labels ?? []).some(item => text(item) === label),
                )
                .map(element => ({
                    hasValue: Boolean((element as HTMLInputElement).value.trim()),
                    disabled: element.matches(":disabled"),
                })),
        );
        const information = {
            contact,
            terms: terms.map(element => (element as HTMLInputElement).checked),
            headingCount: all(document, "*").filter(
                element =>
                    directText(element) === "聯絡人資訊" &&
                    !Array.from(element.children).some(child => directText(child) === "聯絡人資訊"),
            ).length,
        };

        // 付款摘要保留所有列，金額只保留在內部四欄快照，不輸出到公開結果或核價。
        const checkout = summaryRows.map(row => Array.from(row.children).filter(visible).map(text));
        return {
            origin: location.origin,
            pathname: location.pathname,
            extraUrlParts: Boolean(
                location.search || location.hash || new URL(location.href).username || new URL(location.href).password,
            ),
            queueCount,
            activity,
            identities,
            tickets,
            information,
            checkout,
            activityNames: all(document, "h1").map(text),
            nextButtons: buttons(document, "下一步"),
            paymentButtons: buttons(document, "前往付款"),
            checkoutStepCount: checkoutSteps.length,
        };
    });
}

export type TicketPlusDom = Awaited<ReturnType<typeof readTicketPlusDom>>;
