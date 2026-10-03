import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { reportState } from "../../core/state.js";
import { isEventPage } from "./eventPage.js";
import { getSelectionNotices, seatPanelSelector, seatShellSelector } from "./notices.js";
import { KlookQueueRecovery } from "./expiryRecovery.js";

export type LoginState = "logged-in" | "logged-out" | "unknown";

function isKlookUrl(url: string): boolean {
    const parsed = new URL(url);
    return parsed.protocol === "https:" &&
        (parsed.hostname === "klook.com" || parsed.hostname.endsWith(".klook.com"));
}

// 僅讀取可見 DOM 結構，不讀帳戶名稱、輸入值、cookie 或 storage。
export async function readLoginState(page: Page): Promise<LoginState> {
    if (!isKlookUrl(page.url())) return "unknown";
    return page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll("nav.default-header")).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        if (headers.length !== 1) return "unknown";
        const header = headers[0]!;
        const logged = Array.from(header.querySelectorAll(".default-header_logged-in")).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        const signin = Array.from(header.querySelectorAll(".default-header_signin")).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        const panels = Array.from(document.querySelectorAll(".klk-login__dialog")).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
        if (logged.length === 1 && signin.length === 0 && panels.length === 0 &&
            !location.pathname.includes("/signin/") &&
            Array.from(logged[0]!.querySelectorAll(".default-header_avatar")).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden").length === 1) return "logged-in";
        if (logged.length === 0 && signin.length === 1) return "logged-out";
        return "unknown";
    });
}

interface StartupOptions {
    pageTimeout?: number;
    loginTimeout?: number;
    pollInterval?: number;
}

// 登入等待不屬於購票恢復：不刷新、不點登入／送出按鈕，也不動恢復額度。
export async function waitForLogin(page: Page, options: StartupOptions = {}): Promise<void> {
    const pageTimeout = options.pageTimeout ?? 30_000;
    const loginTimeout = options.loginTimeout ?? 300_000;
    let deadline = Date.now() + pageTimeout;
    let manual = false;
    reportState("LOGIN_CHECK");
    while (Date.now() < deadline) {
        if (page.isClosed()) throw new PurchaseStop("瀏覽器已關閉，登入等待已停止。");
        let state: LoginState = "unknown";
        try {
            state = await readLoginState(page);
        } catch {
            // 手動登入可能導頁並銷毀舊 DOM；在原期限內重新觀察，不刷新。
        }
        if (state === "logged-in") return;
        if (state === "logged-out" && !manual) {
            manual = true;
            deadline = Date.now() + loginTimeout;
            reportState("WAITING_FOR_LOGIN");
            console.log(`尚未登入，請在此瀏覽器分頁手動登入；完成後會自動繼續（最多等待 ${Math.ceil(loginTimeout / 1000)} 秒）。`);
        }
        await page.waitForTimeout(options.pollInterval ?? 500);
    }
    throw new PurchaseStop(manual ? "手動登入等待逾時，未開始購票；請保留瀏覽器檢查。" : "無法確認登入狀態，未開始購票；請檢查頁面是否載入或遭到封鎖。");
}

async function navigate(page: Page, url: string, label: string, timeout: number): Promise<void> {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    console.log(`${label}導覽 HTTP 狀態：${response?.status() ?? "未知"}`);
    if (!response || !response.ok()) {
        throw new PurchaseStop(`${label}載入失敗：HTTP ${response?.status() ?? "未知"}；請人工檢查，不會自動重試。`);
    }
}

// 獨立的啟動準備責任；不把新條件加進過期恢復共用的 isEventPageReady。
export async function prepareStartup(page: Page, eventUrl: string, options: StartupOptions = {}): Promise<"ready" | "queue-expired"> {
    if (!isKlookUrl(eventUrl)) throw new PurchaseStop("活動網址必須是 Klook 的 HTTPS 網址。");
    const timeout = options.pageTimeout ?? 30_000;
    try {
        await navigate(page, "https://www.klook.com/zh-TW/", "登入檢查頁", timeout);
        await waitForLogin(page, options);
        await navigate(page, eventUrl, "活動頁", timeout);
        reportState("EVENT_PAGE");
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            if (!isEventPage(page.url(), eventUrl)) throw new PurchaseStop("未到達目標活動頁，未開始購票；請檢查登入或重新導向。");
            const login = await readLoginState(page);
            if (login === "logged-out") throw new PurchaseStop("活動頁登入狀態已失效，未開始購票。");
            const notices = await getSelectionNotices(page);
            const seats = await page.locator(`${seatPanelSelector}, ${seatShellSelector}`).filter({ visible: true }).count();
            if (seats > 0) throw new PurchaseStop("啟動時已有選位畫面，未開始新的購票流程。");
            if (notices.length > 0) {
                if (notices.length === 1 && await new KlookQueueRecovery(page, eventUrl).isRequired()) {
                    if (login === "logged-in") {
                        console.log("活動頁出現已知排隊過期提示，交由既有恢復流程核對；尚未宣告 READY。");
                        return "queue-expired";
                    }
                    // 已知提示不代表頁首已載入；登入未知時仍使用原頁面等待期限。
                    await page.waitForTimeout(options.pollInterval ?? 500);
                    continue;
                }
                throw new PurchaseStop("活動頁有未處理提示，未開始購票；請人工檢查。");
            }
            const tickets = page.locator("#ticket-options");
            if (login === "logged-in" && await tickets.count() === 1 && await tickets.isVisible() &&
                await tickets.locator(".spec-LwNjSh").filter({ visible: true }).count() > 0) {
                reportState("READY");
                console.log("登入與活動頁檢查完成，開始依設定順位選票。");
                return "ready";
            }
            await page.waitForTimeout(options.pollInterval ?? 500);
        }
        throw new PurchaseStop("活動頁準備逾時：登入狀態或選票區尚未就緒，可能尚未開賣或載入異常；未開始購票。");
    } catch (error) {
        reportState("MANUAL_REQUIRED");
        if (error instanceof PurchaseStop) throw error;
        throw new PurchaseStop("啟動準備中斷，未開始購票；請檢查瀏覽器或網路，不會自動重試。");
    }
}
