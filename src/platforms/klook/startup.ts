import { log } from "../../core/logger.js";
import type { SaleSchedule } from "../../core/types.js";
import { validateSaleSchedule } from "../../core/purchaseValidation.js";
import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { reportState } from "../../core/state.js";
import { hasVisibleSeatScreen, isEventPage } from "./eventPage.js";
import { getSelectionNotices, isQueueExpiryShown } from "./notices.js";

export type LoginState = "logged-in" | "logged-out" | "unknown";

export function isKlookUrl(url: string): boolean {
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
    saleSchedule?: SaleSchedule;
    deadline?: number;
    pageTimeout?: number;
    loginTimeout?: number;
    pollInterval?: number;
}

// 登入等待不屬於購票恢復：不刷新、不點登入／送出按鈕，也不動恢復額度。
export async function waitForLogin(page: Page, options: StartupOptions = {}): Promise<void> {
    const pageTimeout = options.pageTimeout ?? 30_000;
    const loginTimeout = options.loginTimeout ?? 300_000;
    let deadline = Math.min(Date.now() + pageTimeout, options.deadline ?? Infinity);
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
            deadline = Math.min(Date.now() + loginTimeout, options.deadline ?? Infinity);
            reportState("WAITING_FOR_LOGIN");
            log(`尚未登入，請在此瀏覽器分頁手動登入；完成後會自動繼續（最多等待 ${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒）。`);
        }
        await page.waitForTimeout(Math.max(0, Math.min(options.pollInterval ?? 500, deadline - Date.now())));
    }
    throw new PurchaseStop(manual ? "手動登入等待逾時，未開始購票；請保留瀏覽器檢查。" : "無法確認登入狀態，未開始購票；請檢查頁面是否載入或遭到封鎖。");
}

async function navigate(page: Page, url: string, label: string, timeout: number): Promise<void> {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
    log(`${label}導覽 HTTP 狀態：${response?.status() ?? "未知"}`);
    if (!response || !response.ok()) {
        throw new PurchaseStop(`${label}載入失敗：HTTP ${response?.status() ?? "未知"}；請人工檢查，不會自動重試。`);
    }
}

// 獨立的啟動準備責任；不把新條件加進過期恢復共用的 isEventPageReady。
export async function prepareStartup(page: Page, eventUrl: string, options: StartupOptions = {}): Promise<"ready" | "queue-expired"> {
    if (!isKlookUrl(eventUrl)) throw new PurchaseStop("活動網址必須是 Klook 的 HTTPS 網址。");
    const timeout = options.pageTimeout ?? 30_000;
    try {
        const saleAt = options.saleSchedule === undefined ? undefined : validateSaleSchedule(options.saleSchedule);
        const deadline = saleAt === undefined ? Infinity : saleAt + 120_000;
        const remaining = () => {
            if (Date.now() >= deadline) throw new PurchaseStop("已超過開賣等待截止時間，未開始購票。");
            return Math.min(timeout, deadline - Date.now());
        };
        await navigate(page, "https://www.klook.com/zh-TW/", "登入檢查頁", remaining());
        await waitForLogin(page, { ...options, deadline });
        await navigate(page, eventUrl, "活動頁", remaining());
        reportState("EVENT_PAGE");
        if (saleAt !== undefined) {
            return await waitForSale(page, eventUrl, saleAt, options);
        }
        const pageDeadline = Date.now() + timeout;
        while (Date.now() < pageDeadline) {
            if (!isEventPage(page.url(), eventUrl)) throw new PurchaseStop("未到達目標活動頁，未開始購票；請檢查登入或重新導向。");
            const login = await readLoginState(page);
            if (login === "logged-out") throw new PurchaseStop("活動頁登入狀態已失效，未開始購票。");
            const notices = await getSelectionNotices(page);
            if (await hasVisibleSeatScreen(page)) throw new PurchaseStop("啟動時已有選位畫面，未開始新的購票流程。");
            if (notices.length > 0) {
                if (notices.length === 1 && await isQueueExpiryShown(page, eventUrl)) {
                    if (login === "logged-in") {
                        log("活動頁出現已知排隊過期提示，交由既有恢復流程核對；尚未宣告 READY。");
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
                log("登入與活動頁檢查完成，開始依設定順位選票。");
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

// 開賣 gate 只執行於 prepareBooking 之前；不持有或重設購票恢復額度。
async function waitForSale(page: Page, eventUrl: string, saleAt: number,
    options: StartupOptions): Promise<"ready" | "queue-expired"> {
    const cutoff = saleAt + 120_000;
    const refreshAt = saleAt - (options.saleSchedule!.advanceSeconds ?? 1) * 1000;
    const loadTimeout = options.pageTimeout ?? 60_000;
    let loadDeadline = Math.min(Date.now() + loadTimeout, cutoff);
    let lastRefresh: number | undefined;
    let prepared = false;
    let unknownSince: number | undefined;
    reportState("WAITING_FOR_SALE");
    log(`等待開賣：${options.saleSchedule!.saleAt}；提前 ${options.saleSchedule!.advanceSeconds ?? 1} 秒刷新。`);

    async function refresh(restoreEvent = false): Promise<void> {
        const started = Date.now();
        // 開賣前手動登入返回活動頁，不算已完成預定的提前刷新。
        lastRefresh = restoreEvent && started < refreshAt ? undefined : started;
        loadDeadline = Math.min(started + loadTimeout, cutoff);
        const timeout = loadDeadline - Date.now();
        if (timeout <= 0) throw new PurchaseStop("已超過開賣等待截止時間。");
        reportState("SALE_REFRESH");
        // 必須等待新導覽成功；逾時直接停止，不讀舊頁面安排下一次刷新。
        const response = restoreEvent
            ? await page.goto(eventUrl, { waitUntil: "domcontentloaded", timeout })
            : await page.reload({ waitUntil: "domcontentloaded", timeout });
        if (!response || !response.ok()) {
            throw new PurchaseStop(`開賣刷新失敗：HTTP ${response?.status() ?? "未知"}；不會自動重試。`);
        }
        unknownSince = undefined;
    }

    while (Date.now() < cutoff) {
        if (page.isClosed()) throw new PurchaseStop("瀏覽器已關閉，開賣等待已停止。");
        if (Date.now() >= loadDeadline) throw new PurchaseStop("開賣頁面載入逾時，未開始購票。");
        if (!isEventPage(page.url(), eventUrl)) throw new PurchaseStop("未到達目標活動頁，開賣等待已停止。");
        const login = await readLoginState(page);
        const notices = await getSelectionNotices(page);
        if (await hasVisibleSeatScreen(page)) {
            throw new PurchaseStop("開賣等待時已有選位畫面，已停止。");
        }
        const queue = notices.length === 1 && await isQueueExpiryShown(page, eventUrl);
        if (notices.length > 0 && !queue) throw new PurchaseStop("活動頁有未處理提示，開賣等待已停止。");
        if (login === "logged-out") {
            await waitForLogin(page, { ...options, deadline: cutoff });
            // 人工登入有獨立等待期限；完成後重新核對 DOM，但不延長整體截止。
            loadDeadline = Math.min(Date.now() + loadTimeout, cutoff);
            unknownSince = undefined;
            // 登入可能導頁，也可能留在活動頁；留在原頁先重新分類，不能蓋掉新提示。
            if (isEventPage(page.url(), eventUrl)) continue;
            const returned = new URL(page.url());
            if (returned.origin !== new URL(eventUrl).origin ||
                !["/", "/zh-TW/", "/zh-TW/bookings/"].includes(returned.pathname) ||
                (await getSelectionNotices(page)).length > 0 ||
                await hasVisibleSeatScreen(page)) {
                throw new PurchaseStop("手動登入後未到達已知返回頁，未重新導覽活動。");
            }
            await refresh(true);
            continue;
        }
        const tickets = page.locator("#ticket-options");
        const uniqueTickets = await tickets.count() === 1 && await tickets.isVisible();
        const states = tickets.locator(".package-wrapper.stateText").filter({ visible: true });
        const stateCount = uniqueTickets ? await states.count() : 0;
        const comingSoon = stateCount === 1 && (await states.innerText()).trim() === "即將開賣";
        const hasOptions = uniqueTickets && await tickets.locator(".spec-LwNjSh").filter({ visible: true }).count() > 0;
        if ((comingSoon && hasOptions) || stateCount > 1) throw new PurchaseStop("開賣頁面狀態互相矛盾，已停止。");
        if (Date.now() >= cutoff || Date.now() >= loadDeadline) {
            throw new PurchaseStop("開賣頁面等待已逾時，未開始購票。");
        }
        const known = login === "logged-in" && (queue || comingSoon || (hasOptions && stateCount === 0));
        if (!known) {
            unknownSince ??= Date.now();
            if (Date.now() - unknownSince >= loadTimeout) throw new PurchaseStop("開賣頁面狀態未知，已停止；不判定售罄。");
        } else {
            unknownSince = undefined;
            loadDeadline = cutoff;
            if (!prepared) {
                prepared = true;
                log("登入與活動頁檢查完成，等待開賣；尚未開始選票。");
            }
            if (queue) {
                // 已知彈窗優先；不以刷新蓋掉它，也不在開賣前消耗恢復額度。
                if (Date.now() >= saleAt) return "queue-expired";
            } else if (lastRefresh !== undefined && hasOptions && Date.now() >= saleAt) {
                reportState("READY");
                log("開賣等待完成，交由既有順位策略核對票券。");
                return "ready";
            } else if ((lastRefresh === undefined && Date.now() >= refreshAt) ||
                (comingSoon && lastRefresh !== undefined && Date.now() >= saleAt && Date.now() - lastRefresh >= 3000)) {
                await refresh();
                continue;
            }
        }
        const nextTrigger = lastRefresh === undefined ? refreshAt : saleAt;
        const delay = nextTrigger > Date.now() ? Math.min(nextTrigger - Date.now(), options.pollInterval ?? 500) : options.pollInterval ?? 500;
        await page.waitForTimeout(Math.max(0, Math.min(delay, cutoff - Date.now())));
    }
    throw new PurchaseStop("已超過開賣後兩分鐘，未開始購票；請檢查活動頁。");
}
