import type { BrowserContext, Page } from "playwright";
import { activity, eventHeader, student, presale, soldOut, information } from "./pages.js";
import { failureDialog, queueDialog } from "./submissionPage.js";

export type CycleMode =
    "success" | "unknown" | "queue" | "residue" | "general-failure" | "all-sold-out" | "skip-A" | "all-rejected";
interface CycleState {
    actions: string[];
    submissions: { name: string; quantity: number }[][];
}
declare global {
    interface Window {
        ticketCycleFixture: CycleState;
    }
}

// 固定 A/B/C 頁面與回應，不讀 production targets。清零情境是模擬，不代表實站關窗必定清零。
export async function installCyclePage(context: BrowserContext, mode: CycleMode): Promise<void> {
    const rowA =
        mode === "all-sold-out" || mode === "skip-A"
            ? soldOut.replace("身障票", "A區")
            : student.replace("學生票", "A區");
    const rowB =
        mode === "all-sold-out"
            ? soldOut.replace("身障票", "B區")
            : presale.replace("預售票", "B區").replace("<div>1</div>", "<div>0</div>");
    const order = `${eventHeader}${rowA}${rowB}${student.replace("學生票", "C區")}<button>更新票數</button><button disabled>下一步</button>`;
    await context.route("**/*", route =>
        route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: new URL(route.request().url()).pathname.startsWith("/activity/") ? activity : order,
        }),
    );
    await context.addInitScript(
        ({ mode, order, information, failure, generalFailure, queue }) => {
            const state: CycleState = { actions: [], submissions: [] };
            window.ticketCycleFixture = state;
            const dom = {
                rows() {
                    return [...document.querySelectorAll(".row.py-1.py-md-4")];
                },
                next() {
                    return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
                        button => button.textContent === "下一步",
                    );
                },
            };
            document.addEventListener("change", () => state.actions.push("change"));
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent === "立即購買") {
                    state.actions.push("session");
                    history.replaceState(null, "", "/order/event-fixture/session-B");
                    document.body.innerHTML = order;
                    return;
                }
                const row = button.closest(".row.py-1.py-md-4");
                if (row) {
                    const name = row.querySelector(".font-weight-medium")!.childNodes[0]!.textContent!.trim();
                    const delta = button.querySelector(".mdi-plus") ? 1 : -1;
                    const value = row.querySelector(".count-button > div")!;
                    value.textContent = String(Number(value.textContent) + delta);
                    row.querySelector<HTMLButtonElement>("button:has(.mdi-minus)")!.disabled =
                        Number(value.textContent) === 0;
                    state.actions.push(name + (delta > 0 ? "+" : "-"));
                    dom.next()!.disabled = dom
                        .rows()
                        .every(row => Number(row.querySelector(".count-button > div")?.textContent ?? 0) === 0);
                    return;
                }
                if (button.dataset.fixture === "dismiss") {
                    state.actions.push("dismiss");
                    document.querySelector(".v-dialog__content")!.remove();
                    if (mode !== "residue") {
                        dom.rows().forEach(row => {
                            const value = row.querySelector(".count-button > div");
                            if (value) value.textContent = "0";
                            const minus = row.querySelector<HTMLButtonElement>("button:has(.mdi-minus)");
                            if (minus) minus.disabled = true;
                        });
                        dom.next()!.disabled = true;
                    }
                    return;
                }
                if (button.textContent === "更新票數") {
                    state.actions.push("refresh");
                    return; // 保留舊 DOM；不能當成更新成功。
                }
                if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        state.actions.push("information-next");
                        return;
                    }
                    state.actions.push("submit");
                    state.submissions.push(
                        dom
                            .rows()
                            .map(row => ({
                                name: row.querySelector(".font-weight-medium")!.childNodes[0]!.textContent!.trim(),
                                quantity: Number(row.querySelector(".count-button > div")?.textContent ?? 0),
                            }))
                            .filter(ticket => ticket.quantity > 0),
                    );
                    if (mode === "general-failure") document.body.insertAdjacentHTML("beforeend", generalFailure);
                    else if (state.submissions.length === 1 || mode === "all-rejected")
                        document.body.insertAdjacentHTML("beforeend", failure);
                    else if (mode === "unknown")
                        document.body.insertAdjacentHTML("beforeend", '<div role="dialog">不明處理狀態</div>');
                    else if (mode === "queue") document.body.insertAdjacentHTML("beforeend", queue);
                    else {
                        history.replaceState(null, "", "/confirm/event-fixture/session-B");
                        document.body.innerHTML = information;
                    }
                    return;
                }
                state.actions.push("other");
            });
        },
        {
            mode,
            order,
            information,
            failure: failureDialog(),
            generalFailure: failureDialog("購票失敗"),
            queue: queueDialog,
        },
    );
}
export async function cycleState(page: Page) {
    return page.evaluate(() => window.ticketCycleFixture);
}
