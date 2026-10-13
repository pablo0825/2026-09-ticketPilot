import type { Page } from "playwright";
import { PurchaseStop } from "../../core/purchaseStop.js";

export const queueRootSelector = ".event_queue_desktop";
export type QueueStage = "countdown" | "waiting" | "admitted" | "unknown";

export interface QueueSnapshot {
    stage: QueueStage;
    seconds?: number;
}

interface QueueDomData {
    rootCount: number;
    notice: boolean;
    sources: (string | null)[];
    percents: string[];
    entryCount: number;
    continueCount: number;
    countdownLabel: boolean;
    admitted: boolean;
    waiting: boolean;
    invalidLink: boolean;
    countdown: number[] | undefined;
    reservation: number[] | undefined;
}

export function isQueuePage(url: string, eventUrl: string): boolean {
    const current = new URL(url);
    const expected = new URL(eventUrl);
    const locale = expected.pathname.split("/")[1];
    return (
        current.origin === expected.origin &&
        current.pathname.startsWith(`/${locale}/platform/queue/`) &&
        /^\/[^/]+\/platform\/queue\/\d+\/$/.test(current.pathname)
    );
}

// 一次讀取同一份文件，避免逐次 locator 讀取遇到網站刷新而等待舊元素。
export async function readQueueSnapshot(page: Page, eventUrl: string): Promise<QueueSnapshot> {
    const expectedId = new URL(eventUrl).pathname.match(/\/event-detail\/(\d+)-/)?.[1];
    if (!expectedId) throw new PurchaseStop("無法核對排隊活動編號，已停止。");

    const data = await readQueueDom(page);
    return classifyQueueSnapshot(data, expectedId, page.url());
}

async function readQueueDom(page: Page): Promise<QueueDomData> {
    return page.evaluate(rootSelector => {
        // 只讀可見的排隊區與提示，不讀帳戶或排隊憑證
        const roots = [...document.querySelectorAll<HTMLElement>(rootSelector)].filter(
            el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
        );
        const notices = [
            ...document.querySelectorAll('.klk-modal-alert, .klk-modal-confirm, [role="dialog"], dialog'),
        ].filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
        const root = roots.length === 1 ? roots[0] : undefined;
        const text = root?.innerText.replace(/\s+/g, " ").trim() ?? "";

        // 以最內層的精確文字辨識入口，避免父子元素重複計數
        const texts = root
            ? [...root.querySelectorAll<HTMLElement>("*")].filter(
                  el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
              )
            : [];
        const [entryCount, continueCount, waitingChineseCount, waitingEnglishCount] = [
            "排隊購票",
            "繼續預訂",
            "排隊中",
            "You're now in the queue!",
        ].map(
            value =>
                texts.filter(
                    el =>
                        el.textContent?.trim() === value &&
                        ![...el.children].some(child => child.textContent?.trim() === value),
                ).length,
        );
        const sources = root
            ? [...root.querySelectorAll<HTMLIFrameElement>("iframe.dynamic-frame")]
                  .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
                  .map(el => el.getAttribute("src"))
            : [];
        const percents = root
            ? [...root.querySelectorAll<HTMLElement>(".qmotion__pct")]
                  .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
                  .map(el => el.innerText.trim())
            : [];

        // 倒數可能由多個 span 組成，保留冒號兩側的空白相容性
        const countdown = text.match(/開賣倒數\s*(\d{2,})\s*:\s*(\d{2})\s*:\s*(\d{2})/);
        const reservation = text.match(/順位保留倒數\s*(\d{2,})\s*:\s*(\d{2})/);
        return {
            rootCount: roots.length,
            notice: notices.length > 0,
            sources,
            percents,
            entryCount: entryCount!,
            continueCount: continueCount!,
            countdownLabel: text.includes("開賣倒數"),
            admitted: text.includes("輪到你了，請盡快完成購票！"),
            waiting: waitingChineseCount === 1 || waitingEnglishCount === 1,
            invalidLink: text.includes("此連結無法使用，請從活動頁面加入排隊"),
            countdown: countdown?.slice(1).map(Number),
            reservation: reservation?.slice(1).map(Number),
        };
    }, queueRootSelector);
}

function classifyQueueSnapshot(data: QueueDomData, expectedId: string, pageUrl: string): QueueSnapshot {
    // 核對活動快照，缺資料僅可暫時等待
    if (data.notice || data.invalidLink) throw new PurchaseStop("排隊頁出現提示，請人工檢查；不會自動重新入隊。");
    if (data.rootCount > 1 || data.sources.length > 1) throw new PurchaseStop("排隊頁活動資料不唯一，已停止。");
    if (data.rootCount !== 1 || data.sources.length !== 1 || !data.sources[0]) return { stage: "unknown" };
    const source = new URL(data.sources[0], pageUrl);
    if (
        source.origin !== "https://cdn.klook.com" ||
        !source.pathname.startsWith(`/event/queue-snapshot/${expectedId}/`)
    ) {
        throw new PurchaseStop("排隊頁與設定活動不符，已停止。");
    }

    // 衝突或重複入口不可當成可點擊的狀態
    if (
        data.entryCount > 1 ||
        data.continueCount > 1 ||
        data.percents.length > 1 ||
        (data.entryCount > 0 && (data.percents.length > 0 || data.continueCount > 0 || data.admitted))
    ) {
        throw new PurchaseStop("排隊頁狀態重複或互相矛盾，已停止。");
    }
    if (data.admitted) {
        if (data.countdownLabel || data.waiting) throw new PurchaseStop("排隊放行狀態互相矛盾，已停止。");
        const clock = data.reservation;
        if (!clock || clock[1]! >= 60) return { stage: "unknown" };
        const seconds = clock[0]! * 60 + clock[1]!;
        if (seconds <= 0) throw new PurchaseStop("順位保留已過期，已停止；不會重新入隊。");
        return { stage: "admitted", seconds };
    }
    if (
        data.waiting &&
        !data.countdownLabel &&
        data.continueCount === 0 &&
        data.percents.length === 1 &&
        /^(?:100|\d{1,2})%$/.test(data.percents[0]!)
    ) {
        return { stage: "waiting" };
    }
    if (data.countdownLabel && data.percents.length === 0 && !data.waiting && data.continueCount === 0) {
        const clock = data.countdown;
        if (!clock || clock[1]! >= 60 || clock[2]! >= 60) return { stage: "unknown" };
        return { stage: "countdown", seconds: clock[0]! * 3600 + clock[1]! * 60 + clock[2]! };
    }
    return { stage: "unknown" };
}
