import type { Page } from "playwright";
import { order, information, queue } from "./pages.js";

export const orderUrl = "https://ticketplus.com.tw/order/event-fixture/session-B";
export const informationUrl = "https://ticketplus.com.tw/confirm/event-fixture/session-B";
export const readyOrder = order.replace("<div>1</div>", "<div>2</div>");
export const readyInformation = information
    .replace('type="checkbox">我已經', 'type="checkbox" checked>我已經')
    .replace('type="button" disabled>下一步', 'type="button">下一步');
export function failureDialog(message = "您選擇的票種已售完", button = "我知道了"): string {
    return `<div class="v-dialog__content"><div role="dialog"><div class="v-dialog"><p>${message}</p><button data-fixture="dismiss">${button}</button></div></div></div>`;
}
export const queueDialog = `<div class="v-dialog__content"><div class="v-dialog" role="dialog">${queue}</div></div>`;
export type Mode = "direct" | "queue" | "failure" | "stay";
export interface FixtureState {
    orderClicks: number;
    dismissClicks: number;
    infoClicks: number;
    otherClicks: number;
    termsChanges: number;
    reads: number;
    show: (phase: "order" | "queue" | "information" | "failure" | "unknown" | "wrong") => void;
}
declare global {
    interface Window {
        submissionFixture: FixtureState;
    }
}

export async function installSubmission(
    page: Page,
    mode: Mode,
    failureHtml = failureDialog(),
    closeMode = "remove",
): Promise<() => number> {
    let requests = 0;
    await page.route("**/*", route => {
        requests++;
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: readyOrder });
    });
    await page.goto(orderUrl);
    await page.evaluate(
        ({ mode, failureHtml, closeMode, order, information, queue }) => {
            // 跳轉與票數固定，不從正式設定或正式辨識常數生成答案。
            const state: FixtureState = {
                orderClicks: 0,
                dismissClicks: 0,
                infoClicks: 0,
                otherClicks: 0,
                termsChanges: 0,
                reads: 0,
                show(phase) {
                    history.replaceState(
                        {},
                        "",
                        phase === "information"
                            ? "/confirm/event-fixture/session-B"
                            : phase === "wrong"
                              ? "/order/event-fixture/session-WRONG"
                              : "/order/event-fixture/session-B",
                    );
                    document.body.innerHTML =
                        phase === "information"
                            ? information
                            : phase === "unknown"
                              ? ""
                              : order + (phase === "queue" ? queue : phase === "failure" ? failureHtml : "");
                    const title = document.querySelector<HTMLElement>(".text-page-title");
                    const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!.get!;
                    if (title) {
                        Object.defineProperty(title, "innerText", {
                            configurable: true,
                            get() {
                                state.reads++;
                                return getter.call(title);
                            },
                        });
                    }
                },
            };
            window.submissionFixture = state;
            state.show("order");
            document.addEventListener("change", event => {
                if ((event.target as Element).matches('input[type="checkbox"]')) state.termsChanges++;
            });
            // 不 preventDefault，保留真的點擊與錯誤導航副作用供測試觀察。
            document.addEventListener("click", event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.dataset.fixture === "dismiss") {
                    state.dismissClicks++;
                    if (closeMode === "remove") state.show("order");
                    if (closeMode === "replace") state.show("failure");
                    if (closeMode === "navigate") state.show("information");
                    return;
                }
                if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        state.infoClicks++;
                        return;
                    }
                    state.orderClicks++;
                    state.show(mode === "direct" ? "information" : mode === "stay" ? "order" : mode);
                    return;
                }
                state.otherClicks++;
            });
        },
        { mode, failureHtml, closeMode, order: readyOrder, information: readyInformation, queue: queueDialog },
    );
    return () => requests;
}
export async function submissionCounts(page: Page) {
    return page.evaluate(() => {
        const { orderClicks, dismissClicks, infoClicks, otherClicks, termsChanges } = window.submissionFixture;
        return { orderClicks, dismissClicks, infoClicks, otherClicks, termsChanges };
    });
}
