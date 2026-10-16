import type { Page } from "playwright";
import { diagnoseReadFailure } from "./readFailure.js";

export type LoginRouteKind = "home" | "activity" | "other";
export interface TicketPlusLoginObservation {
    state: "unknown" | "logged-out" | "logged-in";
    reason:
        | "incomplete"
        | "conflicting"
        | "recognized"
        | "unexpected-route"
        | "route-changed"
        | "navigation-interrupted"
        | "read-failed"
        | "page-closed";
    routeKind: LoginRouteKind;
    markers: {
        headers: number;
        accounts: number;
        logouts: number;
        logins: number;
        dialogs: number;
        menuButtons: number;
        openDrawers: number;
    };
}

function loginRoute(url: string): LoginRouteKind {
    try {
        const parsed = new URL(url);
        if (parsed.origin !== "https://ticketplus.com.tw") return "other";
        if (parsed.pathname === "/") return "home";
        if (/^\/activity\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) return "activity";
    } catch {
        /* 無法解析的網址不屬於登入範圍。 */
    }
    return "other";
}

export async function readTicketPlusLoginState(
    page: Page,
    options: { allowActivity?: boolean } = {},
): Promise<TicketPlusLoginObservation> {
    const before = page.url();
    const routeKind = loginRoute(before);
    const empty = { headers: 0, accounts: 0, logouts: 0, logins: 0, dialogs: 0, menuButtons: 0, openDrawers: 0 };
    if (routeKind !== "home" && !(options.allowActivity && routeKind === "activity")) {
        return { state: "unknown", reason: "unexpected-route", routeKind, markers: empty };
    }
    // 會員標記在同一快照擷取，只回傳計數，不傳出帳號或表單內容。
    try {
        const markers = await page.evaluate(() => {
            const dom = {
                visible(element: Element): boolean {
                    const rect = element.getBoundingClientRect();
                    const style = getComputedStyle(element);
                    return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        rect.bottom > 0 &&
                        rect.right > 0 &&
                        rect.top < innerHeight &&
                        rect.left < innerWidth &&
                        style.visibility !== "hidden" &&
                        style.display !== "none" &&
                        !element.closest('.v-navigation-drawer--close, [hidden], [aria-hidden="true"]')
                    );
                },
                inactiveLoginShell(element: Element): boolean {
                    // 只排除已觀察的非啟用登入外框，未知或多餘內容仍保留阻擋。
                    if (!element.matches(".v-dialog__content:not(.v-dialog__content--active)")) return false;
                    if (element.children.length !== 1) return false;
                    const panel = element.children[0]!;
                    if (!panel.matches(".v-dialog") || getComputedStyle(panel).display !== "none") return false;
                    const directText = [...element.childNodes].some(
                        node => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
                    );
                    if (directText) return false;

                    // 隱藏內容必須仍能確認是登入表單，不將任意隱藏公告當成可忽略。
                    const passwords = panel.querySelectorAll('input[type="password"]');
                    const loginButtons = [...panel.querySelectorAll("button")].filter(
                        button => (button.textContent ?? "").trim() === "登入",
                    );
                    return passwords.length === 1 && loginButtons.length === 1;
                },
                text(element: Element) {
                    return (element.textContent ?? "").trim();
                },
            };
            const { visible, text } = dom;
            const headers = [...document.querySelectorAll("header.headerApp")].filter(visible);
            const drawers = [...document.querySelectorAll("nav.v-navigation-drawer")].filter(visible);
            const roots = [...headers, ...drawers];
            const scoped = {
                unique(selector: string) {
                    return [...new Set(roots.flatMap(root => [...root.querySelectorAll(selector)]))].filter(visible);
                },
            };
            const { unique } = scoped;
            const logout = unique("span.cursor-pointer").filter(element => text(element) === "登出");
            const accounts = logout.filter(element =>
                /^\d{4}\*{3}\d{3}(?:\s|登出|$)/.test(text(element.parentElement!)),
            );
            const logins = unique("span, div, button, a").filter(
                element =>
                    text(element) === "會員登入" && ![...element.children].some(child => text(child) === "會員登入"),
            );
            const dialogs = [...document.querySelectorAll('.v-dialog__content--active, [role="dialog"]')].filter(
                element => visible(element) && !dom.inactiveLoginShell(element),
            );
            const menuButtons = unique("button").filter(
                element => element.matches(".mdi-menu") || element.querySelector(".mdi-menu"),
            );
            return {
                headers: headers.length,
                accounts: accounts.length,
                logouts: logout.length,
                logins: logins.length,
                dialogs: dialogs.length,
                menuButtons: menuButtons.length,
                openDrawers: drawers.length,
            };
        });
        if (page.url() !== before)
            return { state: "unknown", reason: "route-changed", routeKind: loginRoute(page.url()), markers };
        if (
            markers.headers === 1 &&
            markers.accounts === 1 &&
            markers.logouts === 1 &&
            markers.logins === 0 &&
            markers.dialogs === 0
        ) {
            return { state: "logged-in", reason: "recognized", routeKind, markers };
        }
        if (markers.headers === 1 && markers.logins === 1 && markers.accounts === 0 && markers.logouts === 0) {
            return { state: "logged-out", reason: "recognized", routeKind, markers };
        }
        const conflicting =
            markers.accounts > 1 ||
            markers.logouts > 1 ||
            markers.logins > 1 ||
            (markers.logins > 0 && markers.logouts > 0);
        return { state: "unknown", reason: conflicting ? "conflicting" : "incomplete", routeKind, markers };
    } catch (error) {
        const failure = diagnoseReadFailure(error, page, "capture-dom", before, undefined);
        const reason =
            failure.category === "navigation-interrupted"
                ? "navigation-interrupted"
                : failure.category === "page-closed" || failure.category === "target-closed"
                  ? "page-closed"
                  : "read-failed";
        return { state: "unknown", reason, routeKind: loginRoute(page.url()), markers: empty };
    }
}
