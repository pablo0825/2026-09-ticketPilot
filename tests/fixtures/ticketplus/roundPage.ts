import type { BrowserContext, Page } from "playwright";
import { activity, eventHeader, student, soldOut, information } from "./pages.js";

export type RoundMode = "fifth-A" | "both" | "only-B" | "never" | "second-inert";
interface RoundState {
    actions: string[];
    refreshes: number;
    submissions: { name: string; quantity: number }[][];
}
declare global {
    interface Window {
        ticketRoundsFixture: RoundState;
    }
}

// 庫存只由實際更新次數決定，不讀取正式程式的順位或完成旗標。
export async function installRoundPage(context: BrowserContext, mode: RoundMode): Promise<void> {
    const empty = soldOut.replace("身障票", "A區") + soldOut.replace("身障票", "B區");
    const availableA = student.replace("學生票", "A區").replace("剩餘 14", "剩餘 1");
    const availableB = student.replace("學生票", "B區").replace("剩餘 14", "剩餘 1");
    const order = `${eventHeader}<main>${empty}</main><button>更新票數</button><button disabled>下一步</button>`;
    await context.route("**/*", route =>
        route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: new URL(route.request().url()).pathname.startsWith("/activity/") ? activity : order,
        }),
    );
    await context.addInitScript(
        ({ mode, empty, availableA, availableB, information, soldOut, order }) => {
            const state: RoundState = { actions: [], refreshes: 0, submissions: [] };
            window.ticketRoundsFixture = state;
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent?.trim() === "立即購買") {
                    state.actions.push("session");
                    history.replaceState(null, "", "/order/event-fixture/session-B");
                    document.body.innerHTML = order;
                    return;
                }
                if (button.textContent === "更新票數") {
                    state.actions.push("refresh");
                    state.refreshes++;
                    if (mode === "second-inert" && state.refreshes === 2) return;
                    button.remove();
                    // 不同事件階段移除動態資料、恢復資料及重新建立按鈕。
                    setTimeout(() => {
                        document
                            .querySelectorAll(".font-weight-medium > span, .count-button")
                            .forEach(node => node.remove());
                        document.querySelectorAll("span").forEach(node => {
                            if (node.textContent === "已售完") node.remove();
                        });
                        setTimeout(() => {
                            let rows = empty;
                            if (mode === "both") rows = availableA + availableB;
                            if (mode === "only-B") rows = soldOut.replace("身障票", "A區") + availableB;
                            if (mode === "fifth-A" && state.refreshes >= 4)
                                rows = availableA + soldOut.replace("身障票", "B區");
                            document.querySelector("main")!.innerHTML = rows;
                            setTimeout(
                                () => document.body.insertAdjacentHTML("beforeend", "<button>更新票數</button>"),
                                20,
                            );
                        }, 20);
                    }, 0);
                    return;
                }
                const row = button.closest(".rwd-margin");
                if (row) {
                    const name = row.querySelector(".font-weight-medium")!.childNodes[0]!.textContent!.trim();
                    const count = row.querySelector(".count-button > div")!;
                    const plus = Boolean(button.querySelector(".mdi-plus"));
                    count.textContent = String(Number(count.textContent) + (plus ? 1 : -1));
                    state.actions.push(name + (plus ? "+" : "-"));
                    row.querySelector<HTMLButtonElement>("button:has(.mdi-minus)")!.disabled =
                        Number(count.textContent) === 0;
                    [...document.querySelectorAll("button")].find(item => item.textContent === "下一步")!.disabled =
                        false;
                    return;
                }
                if (button.textContent === "下一步") {
                    state.actions.push(location.pathname.startsWith("/confirm/") ? "information-next" : "submit");
                    state.submissions.push(
                        [...document.querySelectorAll(".rwd-margin")]
                            .map(row => ({
                                name: row.querySelector(".font-weight-medium")!.childNodes[0]!.textContent!.trim(),
                                quantity: Number(row.querySelector(".count-button > div")?.textContent ?? 0),
                            }))
                            .filter(ticket => ticket.quantity > 0),
                    );
                    history.replaceState(null, "", "/confirm/event-fixture/session-B");
                    document.body.innerHTML = information;
                }
            });
        },
        { mode, empty, availableA, availableB, information, soldOut, order },
    );
}
export async function roundState(page: Page): Promise<RoundState> {
    return page.evaluate(() => window.ticketRoundsFixture);
}
