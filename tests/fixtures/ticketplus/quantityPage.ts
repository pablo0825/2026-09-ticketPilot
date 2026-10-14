import type { Page } from "playwright";
import { eventHeader, student, presale, soldOut } from "./pages.js";

export type QuantityBehavior =
    "normal" | "none" | "jump" | "wrong-ticket" | "partial" | "delayed" | "reset" | "session-change" | "queue";
export interface QuantityFixtureOptions {
    count?: number;
    studentCount?: number;
    name?: string;
    behavior?: QuantityBehavior;
    disablePlus?: boolean;
    disableMinus?: boolean;
    html?: string;
}
interface FixtureState {
    clicks: Record<string, number>;
    pending: boolean;
    readsWhilePending: number;
    earlyClicks: number;
    acknowledge(): void;
}
declare global {
    interface Window {
        quantityFixture: FixtureState;
    }
}

// 已觀察的 DOM 結構重建；data-fixture 僅供測試記錄，正式選擇器不得使用。
export const quantityPage = `${eventHeader}${student.replace('class="row ', 'data-fixture="student" class="row ')}${presale.replace('class="row ', 'data-fixture="presale" class="row ')}${soldOut}
<button data-fixture-action="next">下一步</button><button data-fixture-action="refresh">更新票數</button>`;

export async function installQuantityFixture(page: Page, options: QuantityFixtureOptions = {}): Promise<void> {
    await page.route("**/*", route =>
        route.fulfill({ contentType: "text/html; charset=utf-8", body: options.html ?? quantityPage }),
    );
    await page.goto("https://ticketplus.com.tw/order/event-fixture/session-B");
    await page.evaluate(options => {
        const state: FixtureState = {
            clicks: { studentPlus: 0, studentMinus: 0, presalePlus: 0, presaleMinus: 0, next: 0, refresh: 0, other: 0 },
            pending: false,
            readsWhilePending: 0,
            earlyClicks: 0,
            acknowledge() {
                state.pending = false;
                dom.change("presale", 1);
            },
        };
        const dom = {
            row(key: string): Element | null {
                return document.querySelector(`[data-fixture="${key}"]`);
            },
            count(key: string): HTMLElement | null {
                return dom.row(key)?.querySelector<HTMLElement>(".count-button > div") ?? null;
            },
            set(key: string, value: number): void {
                const row = dom.row(key);
                const counter = dom.count(key);
                if (!row || !counter) return;
                counter.textContent = String(value);
                const minus = row.querySelector<HTMLButtonElement>("button:has(.mdi-minus)");
                if (minus) minus.disabled = value === 0 || Boolean(options.disableMinus);
            },
            change(key: string, delta: number): void {
                const counter = dom.count(key);
                if (counter) dom.set(key, Number(counter.textContent) + delta);
            },
        };
        window.quantityFixture = state;
        dom.set("student", options.studentCount ?? 0);
        dom.set("presale", options.count ?? 0);
        const label = dom.row("presale")?.querySelector(".font-weight-medium");
        if (label && options.name !== undefined) label.childNodes[0]!.textContent = options.name;
        const plus = dom.row("presale")?.querySelector<HTMLButtonElement>("button:has(.mdi-plus)");
        if (plus && options.disablePlus) plus.disabled = true;

        // 獨立觀察 reader 是否在等待第一個更新，不用 sleep 猜測順序。
        const counter = dom.count("presale");
        const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText")!.get!;
        let resetScheduled = false;
        if (counter) {
            Object.defineProperty(counter, "innerText", {
                get() {
                    if (state.pending) state.readsWhilePending++;
                    const value = getter.call(counter) as string;
                    if (
                        options.behavior === "reset" &&
                        value === "1" &&
                        state.clicks.presalePlus === 1 &&
                        !resetScheduled
                    ) {
                        resetScheduled = true;
                        queueMicrotask(() => dom.set("presale", 0));
                    }
                    return value;
                },
            });
        }

        // 每顆按鈕只按自己的固定規則改 DOM，不讀 production 設定或目標張數。
        document.addEventListener("click", event => {
            const button = (event.target as Element).closest("button");
            if (!button) return;
            const row = button.closest("[data-fixture]");
            const key = row?.getAttribute("data-fixture");
            const delta = button.querySelector(".mdi-plus") ? 1 : button.querySelector(".mdi-minus") ? -1 : 0;
            if (!key || !delta) {
                const action = button.getAttribute("data-fixture-action") ?? "other";
                state.clicks[action] = (state.clicks[action] ?? 0) + 1;
                return;
            }
            const action = key + (delta === 1 ? "Plus" : "Minus");
            state.clicks[action] = (state.clicks[action] ?? 0) + 1;
            if (state.pending) state.earlyClicks++;
            if (key !== "presale") {
                dom.change(key, delta);
                return;
            }
            switch (options.behavior) {
                case "none":
                    state.pending = true;
                    return;
                case "partial":
                    if (state.clicks[action]! > 1) return;
                    break;
                case "delayed":
                    if (state.clicks[action] === 1) {
                        state.pending = true;
                        return;
                    }
                    break;
                case "jump":
                    dom.change(key, delta * 2);
                    return;
                case "wrong-ticket":
                    dom.change("student", delta);
                    return;
                case "session-change":
                    history.replaceState(null, "", "/order/event-fixture/another-session");
                    return;
                case "queue":
                    document.body.insertAdjacentHTML("beforeend", "<h3>排隊購票中 請稍候</h3>");
                    return;
            }
            dom.change(key, delta);
        });
    }, options);
}

// 用 fixture 自己的標記／textContent 讀張數，不能把正式 reader 當唯一裁判。
export async function quantityState(page: Page) {
    return page.evaluate(() => ({
        counts: Object.fromEntries(
            ["student", "presale"].map(key => [
                key,
                document.querySelector(`[data-fixture="${key}"] .count-button > div`)?.textContent?.trim(),
            ]),
        ),
        clicks: window.quantityFixture.clicks,
        pending: window.quantityFixture.pending,
        earlyClicks: window.quantityFixture.earlyClicks,
    }));
}
