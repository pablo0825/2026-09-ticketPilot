import type { Page } from "playwright";
import { DomCaptureError } from "./domReadFailure.js";
import type { DomReadDetail } from "./domReadFailure.js";
import { withTicketRows } from "./ticketRowFinder.js";

// 同一次同步 DOM 讀取取得網址與欄位，避免跨 await 拼接不同畫面。
// 不回傳 input value、整頁文字、HTML 或原始錯誤。
export interface RefreshEvidence {
    clicked: boolean;
    buttonAbsent: boolean;
    dynamicGap: boolean;
    invalid: boolean;
}
export interface RefreshMonitorRequest {
    token: string;
    action: "install" | "read" | "dispose";
    expiresAt: number;
}

// 整頁讀取在瀏覽器內執行；找票種列的規則來自 ticketRowFinder，與點擊共用。
const readInPage = withTicketRows((findLayout, request: RefreshMonitorRequest | undefined) => {
    const visibility = {
        visible(element: Element): boolean {
            const style = getComputedStyle(element);
            return (
                element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse"
            );
        },
    };
    const capture = {
        read() {
            let detail: DomReadDetail | undefined;
            let readLocation: Pick<DomReadDetail, "field" | "rowIndex" | "elementIndex"> = {
                field: "page.text",
                rowIndex: null,
                elementIndex: null,
            };
            try {
                // 使用物件方法，避免 tsx 替獨立箭頭函式加入無法序列化的名稱輔助函式。
                const dom = {
                    visible: visibility.visible,
                    all(root: ParentNode, selector: string): Element[] {
                        return Array.from(root.querySelectorAll(selector)).filter(dom.visible);
                    },
                    text(element: Element): string {
                        let operation: DomReadDetail["operation"] = "read-inner-text";
                        let valueType: DomReadDetail["valueType"] = "unread";
                        try {
                            const value = (element as HTMLElement).innerText;
                            valueType = typeof value;
                            operation = "trim-inner-text";
                            return value.trim();
                        } catch (error) {
                            // 僅保存固定種類與快照內位置，不帶出內容或自訂標籤名稱。
                            const tag = element.localName;
                            const tags = [
                                "div",
                                "span",
                                "h1",
                                "h3",
                                "button",
                                "label",
                                "i",
                                "svg",
                                "path",
                                "circle",
                                "rect",
                                "g",
                                "text",
                            ] as const;
                            const tagName = tags.find(candidate => candidate === tag) ?? "other";
                            const namespace =
                                element.namespaceURI === "http://www.w3.org/1999/xhtml"
                                    ? "html"
                                    : element.namespaceURI === "http://www.w3.org/2000/svg"
                                      ? "svg"
                                      : "other";
                            detail = { ...readLocation, operation, valueType, tagName, namespace };
                            throw error;
                        }
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
                    activityField(row: Element, label: "日期" | "時間", rowIndex: number) {
                        // 響應式標籤可隱藏，只用固定文字定位可見欄位容器。
                        const labels = Array.from(row.querySelectorAll("div.wordBreakKeepAll")).filter(
                            element =>
                                element.textContent?.trim() === label &&
                                element.parentElement?.matches(".d-flex") &&
                                dom.visible(element.parentElement),
                        );
                        const values = labels.flatMap(element =>
                            Array.from(element.parentElement!.children).filter(
                                child =>
                                    child !== element &&
                                    child.matches("div:not(.wordBreakKeepAll)") &&
                                    dom.visible(child),
                            ),
                        );

                        // 只讀值容器；保留重複容器，診斷沿用同一次快照的位置。
                        const previous = readLocation;
                        try {
                            const texts = values.map((element, elementIndex) => {
                                readLocation = {
                                    field: label === "日期" ? "activity.dates" : "activity.times",
                                    rowIndex,
                                    elementIndex,
                                };
                                return dom.text(element);
                            });
                            return { labelCount: labels.length, valueCount: values.length, texts };
                        } finally {
                            readLocation = previous;
                        }
                    },
                    leafTexts(root: ParentNode, field: DomReadDetail["field"], rowIndex: number): string[] {
                        const previous = readLocation;
                        try {
                            return dom
                                .all(root, "*")
                                .filter(element => !Array.from(element.children).some(dom.visible))
                                .map((element, elementIndex) => {
                                    readLocation = { field, rowIndex, elementIndex };
                                    return dom.text(element);
                                });
                        } finally {
                            readLocation = previous;
                        }
                    },
                };
                const { visible, all, text, directText, enabled, buttons, leafTexts } = dom;

                // 僅讀已觀察的流程標記，不把隱藏標題或空對話框當成排隊。
                const queueCount = all(document, 'h3, [role="heading"][aria-level="3"]').filter(
                    element => text(element).replace(/\s+/g, " ") === "排隊購票中 請稍候",
                ).length;
                const sessions = all(document, ".sesstion-item");
                // 選票頁以價格找列；其他頁面沿用原 class，只用來偵測殘留的選票列，行為不變。
                const onOrderPage = location.pathname.startsWith("/order/");
                const layout = onOrderPage ? findLayout() : { rows: [], areas: [] };
                const ticketRows = onOrderPage
                    ? layout.rows
                    : all(document, ".row.py-1.py-md-4.rwd-margin.no-gutters").map(row => ({
                          row,
                          names: all(row, ":scope > .font-weight-medium").map(directText),
                          area: null,
                      }));
                const summaryRows = all(document, ".row.py-2.py-md-3.no-gutters");
                const terms = all(document, 'input[type="checkbox"]').filter(element => {
                    const input = element as HTMLInputElement;
                    return Array.from(input.labels ?? []).some(label =>
                        /^我已經閱讀並同意\s*會員服務條款\s*與\s*隱私權政策$/.test(text(label)),
                    );
                });
                const checkoutSteps = all(document, ".stepText.checkedStep").filter(
                    element => text(element) === "付款結帳",
                );

                // 活動與場次只讀公開文字；資料頁不掃描整頁，避免帶出聯絡人值。
                const activity = sessions.map((row, rowIndex) => {
                    const date = dom.activityField(row, "日期", rowIndex);
                    const time = dom.activityField(row, "時間", rowIndex);
                    const datePattern = /^\d{4}-\d{2}-\d{2}(?:\([一二三四五六日]\))?$/;

                    // 日期範圍只在日期欄位內拆分，未知格式不擷取其中片段。
                    const dates = date.texts.flatMap(value => {
                        const parts = value.split("~").map(part => part.trim());
                        return parts.length <= 2 && parts.every(part => datePattern.test(part)) ? parts : [];
                    });
                    return {
                        names: all(row, ".font-weight-bold.is-word-break").map(text),
                        dateField: { labels: date.labelCount, values: date.valueCount },
                        timeField: { labels: time.labelCount, values: time.valueCount },
                        dates,
                        times: time.texts.filter(value => /^\d{2}:\d{2}$/.test(value)),
                        timeRanges: time.texts.filter(value => /^\d{2}:\d{2}\s*~\s*\d{2}:\d{2}$/.test(value)),
                        saleButtons: all(row, "button").map(element => ({
                            text: text(element),
                            enabled: enabled(element),
                        })),
                    };
                });
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
                const tickets = ticketRows.map(({ row, names, area }, rowIndex) => {
                    const labels = all(row, ":scope > .font-weight-medium");
                    const counters = all(row, ".count-button");
                    // 售完與暫無票券共用同一次葉節點讀取；讀取失敗診斷仍標為 tickets.soldOut 欄位。
                    const leaves = leafTexts(row, "tickets.soldOut", rowIndex);
                    return {
                        names,
                        area,
                        statuses: labels
                            .flatMap(label =>
                                Array.from(label.children)
                                    .filter(visible)
                                    .filter(child => child.tagName === "SPAN")
                                    .map(text),
                            )
                            .filter(Boolean),
                        soldOut: leaves.filter(value => value === "已售完").length,
                        unavailable: leaves.filter(value => value === "暫無票券").length,
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

                // 彈窗採局部可見性規則，不改變既有票種／場次的判讀。
                const modal = {
                    visible(element: Element): boolean {
                        if (!element.getClientRects().length) return false;
                        for (let node: Element | null = element; node; node = node.parentElement) {
                            const style = getComputedStyle(node);
                            if (
                                style.display === "none" ||
                                style.visibility === "hidden" ||
                                style.visibility === "collapse" ||
                                style.opacity === "0" ||
                                node.hasAttribute("hidden")
                            )
                                return false;
                        }
                        return true;
                    },
                    message(element: Element): string {
                        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                        const parts: string[] = [];
                        while (walker.nextNode()) {
                            const parent = walker.currentNode.parentElement;
                            if (
                                parent &&
                                !parent.closest('button, [role="button"], script, style, [aria-hidden="true"]') &&
                                modal.visible(parent)
                            ) {
                                parts.push(walker.currentNode.textContent ?? "");
                            }
                        }
                        return parts.join("").replace(/[\s，。！!：:]/g, "");
                    },
                };
                const candidates = Array.from(
                    document.querySelectorAll('[role="dialog"], .v-dialog, .v-dialog__content'),
                );
                const active = candidates.filter(element => modal.visible(element) && text(element).length > 0);
                const contents = active.filter(
                    element => !active.some(other => other !== element && element.contains(other)),
                );
                const messages: Record<string, "sold-out" | "purchase-failed"> = {
                    購票失敗: "purchase-failed",
                    您選擇的票種已售完: "sold-out",
                    已售完: "sold-out",
                    別人搶先一步: "purchase-failed",
                    已無可配座位: "purchase-failed",
                    本活動有限制購票總張數: "purchase-failed",
                    已被購買: "purchase-failed",
                    無法購票: "purchase-failed",
                };
                const dialogs = contents.map(element => {
                    const message = modal.message(element);
                    const key = Object.hasOwn(messages, message)
                        ? message
                        : message.startsWith("購票失敗")
                          ? message.slice(4)
                          : "";
                    const failure = Object.hasOwn(messages, key) ? messages[key] : undefined;

                    // 活動頁提醒只認白名單標題，且按鈕恰為「回到首頁」「確定」各一。
                    const firstLine = (element as HTMLElement).innerText
                        .split("\n")
                        .map(line => line.trim())
                        .find(Boolean);
                    const buttonNames = all(element, 'button, [role="button"]')
                        .filter(modal.visible)
                        .filter(enabled)
                        .map(text)
                        .sort();
                    const noticeTitle =
                        location.pathname.startsWith("/activity/") &&
                        (firstLine === "實名抽選制售票提醒" || firstLine === "入場規定") &&
                        buttonNames.join("|") === ["回到首頁", "確定"].sort().join("|")
                            ? firstLine
                            : undefined;

                    const kind: "failure" | "queue" | "notice" | "unknown" = failure
                        ? "failure"
                        : message === "排隊購票中請稍候" &&
                            all(element, 'h3, [role="heading"][aria-level="3"]').length === 1
                          ? "queue"
                          : noticeTitle
                            ? "notice"
                            : "unknown";
                    const dismissNames = all(element, 'button, [role="button"]')
                        .filter(modal.visible)
                        .filter(enabled)
                        .map(text)
                        .filter(value => ["我知道了", "知道了", "確定", "OK", "Ok"].includes(value));
                    // 只有白名單訊息回傳固定 key，未知文字與個資不離開瀏覽器。
                    return {
                        index: candidates.indexOf(element),
                        kind,
                        failure,
                        messageKey: failure ? message : undefined,
                        dismissNames,
                        noticeTitle,
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
                        location.search ||
                        location.hash ||
                        new URL(location.href).username ||
                        new URL(location.href).password,
                    ),
                    queueCount,
                    dialogs,
                    activity,
                    identities,
                    tickets,
                    // 票區標題元素不能帶出瀏覽器，只回傳讀到的文字與狀態。
                    areas: layout.areas.map(area => ({
                        names: area.names,
                        stock: area.stock,
                        expanded: area.expanded,
                        hiddenQuantities: area.hiddenQuantities,
                    })),
                    information,
                    checkout,
                    activityNames: all(document, "h1").map(text),
                    nextButtons: buttons(document, "下一步"),
                    refreshButtons: buttons(document, "更新票數"),
                    paymentButtons: buttons(document, "前往付款"),
                    checkoutStepCount: checkoutSteps.length,
                };
            } catch (error) {
                if (detail) return { captureFailure: detail };
                throw error;
            }
        },
    };
    // 監測與一般快照共用同一讀取；只記錄本次點擊後的過渡，不執行購票操作。
    const host = window as unknown as {
        ticketPilotRefresh?: {
            token: string;
            evidence: RefreshEvidence;
            dispose(): void;
        };
    };
    if (request?.action === "dispose" && host.ticketPilotRefresh?.token === request.token) {
        host.ticketPilotRefresh.dispose();
    }
    if (request?.action === "install" && Date.now() < request.expiresAt) {
        host.ticketPilotRefresh?.dispose();
        const baseline = capture.read();
        if (!("captureFailure" in baseline)) {
            const buttons = Array.from(document.querySelectorAll("button")).filter(
                element => visibility.visible(element) && element.innerText.trim() === "更新票數",
            );
            const button = buttons.length === 1 ? buttons[0] : undefined;
            const evidence: RefreshEvidence = {
                clicked: false,
                buttonAbsent: false,
                dynamicGap: false,
                invalid: false,
            };
            const names = JSON.stringify(baseline.tickets.map(row => row.names));
            const areaNames = JSON.stringify(baseline.areas.map(area => area.names));
            const identities = JSON.stringify(baseline.identities);
            const observer = new MutationObserver(() => {
                if (!evidence.clicked) return;
                try {
                    const current = capture.read();
                    if ("captureFailure" in current) {
                        evidence.invalid = true;
                        return;
                    }
                    if (
                        current.origin !== baseline.origin ||
                        current.pathname !== baseline.pathname ||
                        current.extraUrlParts ||
                        JSON.stringify(current.identities) !== identities ||
                        current.dialogs.length ||
                        current.queueCount ||
                        current.activity.length ||
                        current.information.headingCount ||
                        current.information.terms.length ||
                        current.information.contact.some(fields => fields.length) ||
                        current.paymentButtons.length ||
                        current.checkoutStepCount ||
                        current.checkout.length ||
                        current.tickets.some(row => row.quantities.some(value => value !== "0")) ||
                        current.areas.some(area => area.hiddenQuantities.some(value => value !== "0"))
                    ) {
                        evidence.invalid = true;
                        return;
                    }
                    if (current.refreshButtons.length === 0) evidence.buttonAbsent = true;
                    // 空窗：庫存文字暫時消失，其他資料不變（形狀規則與 refreshReadiness 相同，名稱不變由此處比對）。
                    // 實站計數器可能保留，但形狀須完整；張數非零已在上方判為無效。
                    const countersComplete = current.tickets.every(
                        row =>
                            row.counterCount <= 1 &&
                            row.quantities.length === row.counterCount &&
                            row.plus.length === row.counterCount &&
                            row.minus.length === row.counterCount,
                    );

                    // 票種列版型：每列的庫存、售完與暫無票券文字都消失，票名不變。
                    const rowGap =
                        current.areas.length === 0 &&
                        names === JSON.stringify(current.tickets.map(row => row.names)) &&
                        current.tickets.length > 0 &&
                        current.tickets.every(
                            row => row.statuses.length === 0 && row.soldOut === 0 && row.unavailable === 0,
                        );

                    // 票區面板版型：每個票區標題的庫存文字都消失，票區名稱不變；展開票區內的列可保留。
                    const areaGap =
                        current.areas.length > 0 &&
                        areaNames === JSON.stringify(current.areas.map(area => area.names)) &&
                        current.areas.every(area => area.stock.length === 0);
                    if (countersComplete && (rowGap || areaGap)) evidence.dynamicGap = true;
                } catch {
                    evidence.invalid = true;
                }
            });
            const listener = {
                handleEvent(event: Event) {
                    if (event.target instanceof Element && event.target.closest("button") === button) {
                        evidence.clicked = true;
                    }
                },
            };
            const state = {
                token: request.token,
                evidence,
                dispose() {
                    observer.disconnect();
                    document.removeEventListener("click", listener, true);
                    clearTimeout(timer);
                    if (host.ticketPilotRefresh === state) delete host.ticketPilotRefresh;
                },
            };
            const timer = setTimeout(() => state.dispose(), Math.max(0, request.expiresAt - Date.now()));
            host.ticketPilotRefresh = state;
            document.addEventListener("click", listener, true);
            observer.observe(document.body, {
                subtree: true,
                childList: true,
                characterData: true,
                attributes: true,
            });
        }
    }
    // 當前畫面及已記錄證據一起回傳，不能用較晚證據拼接較早快照。
    const snapshot = capture.read();
    const active = host.ticketPilotRefresh;
    return {
        ...snapshot,
        refreshEvidence:
            request?.action === "read" && active?.token === request.token ? { ...active.evidence } : undefined,
    };
});

export async function readTicketPlusDom(page: Page, monitor?: RefreshMonitorRequest) {
    const result = await page.evaluate(readInPage, monitor);
    if ("captureFailure" in result && result.captureFailure) throw new DomCaptureError(result.captureFailure);
    return result;
}

export type TicketPlusDom = Awaited<ReturnType<typeof readTicketPlusDom>>;
