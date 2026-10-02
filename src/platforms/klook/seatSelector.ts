import { PurchaseStop } from "../../core/purchaseStop.js";
import { SeatExpiredBeforeConfirmationError } from "../../core/seatExpiry.js";
import type { Locator, Page } from "playwright";
import type { TicketTarget } from "../../core/types.js";
import { log } from "../../core/logger.js";

export interface AssignedSeat {
    section: string;
    row: string;
    number: string;
}

export interface SeatResult {
    text: string;
    area: string;
    total: string;
    seats: AssignedSeat[];
}

// 取自實際選位彈窗；只讀取主頁的配位結果，不操作座位圖 iframe。
const selectors = {
    panel: ".main_right-ZMnX67",
    list: ".seat_list-BhwLqz",
    area: ".seat_list_cat-vMvUjF",
    seat: ".list_item-jYRAN7",
    total: ".con_seats-a3N26U",
};

function normalize(text: string): string {
    return text.normalize("NFKC").replace(/\s/g, "");
}

function checkSession(text: string, target: TicketTarget): string | undefined {
    const [year, month, day] = target.date.split("-").map(Number);
    const [hour, minute] = target.time.split(":").map(Number);
    const dateTime = new RegExp(`${year}\\s*年\\s*0?${month}\\s*月\\s*0?${day}\\s*日\\s*(?:週|星期)[一二三四五六日天]\\s*(上午|下午)\\s*(\\d{1,2}):(\\d{2})(?!\\d)`);
    // 保留換行／空白，否則場次 12:00 與倒數 00:06 會變成 12:0000:06。
    const match = text.normalize("NFKC").match(dateTime);
    if (!match) return `尚未讀到 ${target.date} 的完整場次資料`;

    const displayedHour = Number(match[2]);
    if (displayedHour < 1 || displayedHour > 12) return "場次時間格式無法辨識";
    const actualHour = displayedHour % 12 + (match[1] === "下午" ? 12 : 0);
    const actualMinute = Number(match[3]);
    if (actualHour !== hour || actualMinute !== minute) {
        const actualTime = `${String(actualHour).padStart(2, "0")}:${String(actualMinute).padStart(2, "0")}`;
        return `時間不符：預期 ${target.time}，實際 ${actualTime}`;
    }
    return undefined;
}

function checkArea(area: string, wanted: string): string | undefined {
    const actual = normalize(area).replace(/\(NT\$[\d,]+\)$/, "");
    if (actual !== normalize(wanted)) return `票種不符：預期 ${wanted}，實際 ${area.trim() || "尚未出現"}`;
    return undefined;
}

function checkSeats(result: SeatResult, quantity: number): string | undefined {
    if (normalize(result.total) !== `共計${quantity}個座位` ||
        !normalize(result.text).includes(`已選${quantity}個座位`)) {
        return `座位數標示尚未符合 ${quantity} 張`;
    }
    if (result.seats.length !== quantity) return `座位明細數量不符：預期 ${quantity} 筆，實際 ${result.seats.length} 筆`;
    if (result.seats.some(seat => !seat.section.trim() || !seat.row.trim() || !seat.number.trim())) {
        return "座位資料不完整：區、排、座號不可缺少";
    }
    const keys = result.seats.map(seat => JSON.stringify([seat.section, seat.row, seat.number].map(normalize)));
    if (new Set(keys).size !== quantity) return "座位明細出現重複座位";
    return undefined;
}

// undefined 代表核對通過；字串是尚未符合的原因，不代表售罄。
export function getSeatResultMismatch(result: SeatResult, target: TicketTarget): string | undefined {
    return checkSession(result.text, target)
        ?? checkArea(result.area, target.area)
        ?? checkSeats(result, target.quantity);
}

// 保留原本的布林介面，既有呼叫端與測試不需變更。
export function matchesSeatResult(result: SeatResult, target: TicketTarget): boolean {
    return getSeatResultMismatch(result, target) === undefined;
}

export class KlookSeatSelector {
    private readonly panel: Locator;

    constructor(private readonly page: Page, private readonly timeout = 30_000) {
        this.panel = page.locator(selectors.panel);
    }

    async openAndVerify(target: TicketTarget, observeFailure?: () => Promise<void>): Promise<AssignedSeat[]> {
        await this.openSeatDialog();
        const result = await this.waitForMatchingSeats(target, observeFailure);
        this.logResult(result);
        return result.seats;
    }

    async confirmVerifiedSeats(target: TicketTarget, expectedSeats: AssignedSeat[]): Promise<void> {
        await this.throwIfSeatReservationExpired();
        if (!await this.isPanelVisible()) throw new Error("選位彈窗已關閉，無法確認。");
        // 點擊前重讀，避免送出已改變的配位結果。
        const result = await this.readSeatResult();
        this.throwIfSeatError(result.text);
        const mismatch = getSeatResultMismatch(result, target);
        if (mismatch) throw new Error(`確認前核對失敗：${mismatch}`);
        const seatKeys = (seats: AssignedSeat[]) => seats.map(seat =>
            JSON.stringify([seat.section, seat.row, seat.number].map(normalize))).sort();
        if (JSON.stringify(seatKeys(result.seats)) !== JSON.stringify(seatKeys(expectedSeats))) {
            throw new Error("確認前座位已改變，已停止。");
        }
        if (!await this.isConfirmReady()) throw new Error("確認按鈕目前無法操作，已停止。");
        await this.throwIfSeatReservationExpired();
        await this.panel.getByRole("button", { name: "確認", exact: true }).click({ timeout: this.timeout });
        log("已按選位確認，等待填寫資料頁；不會重複點擊。");
    }

    private async openSeatDialog(): Promise<void> {
        if (await this.isPanelVisible()) throw new Error("已有選位彈窗，請先人工確認目前狀態。");
        const next = this.page.locator("#ticket-options").getByRole("button", { name: "下一步", exact: true });
        await next.click({ timeout: this.timeout }); // 只點一次，後續只讀取 DOM。
    }

    private async waitForMatchingSeats(target: TicketTarget, observeFailure?: () => Promise<void>): Promise<SeatResult> {
        const deadline = Date.now() + this.timeout;
        let lastReason = "選位彈窗尚未出現";
        while (Date.now() < deadline) {
            await observeFailure?.();
            await this.checkObservationDialog();
            await this.throwIfSeatReservationExpired();
            if (await this.isPanelVisible()) {
                const result = await this.readSeatResult();
                this.throwIfSeatError(result.text);
                const mismatch = getSeatResultMismatch(result, target);
                if (mismatch) lastReason = mismatch;
                else if (await this.isConfirmReady()) return result;
                else lastReason = "確認按鈕尚未可操作或不唯一";
            } else {
                lastReason = "選位彈窗尚未出現或已關閉";
            }
            await this.page.waitForTimeout(200);
        }
        throw new PurchaseStop(`等待配位結果逾時：${lastReason}；狀態未知，未判定售罄。`);
    }

    private async checkObservationDialog(): Promise<void> {
        const dialogs = this.page.locator('.klk-modal-alert, [role="dialog"], dialog').filter({ visible: true });
        // 座位面板本身可能是 dialog；只檢查面板外的提示。
        const notices = [];
        for (const dialog of await dialogs.all()) {
            if (!await dialog.locator(selectors.panel).count() &&
                !await dialog.evaluate(el => el.matches(".main_right-ZMnX67, .seatModal"))) notices.push(dialog);
        }
        if (notices.length === 0) return;
        if (notices.length !== 1) throw new PurchaseStop("配位時出現多個提示，已停止操作。");
        const text = (await notices[0]!.innerText()).trim();
        if (/^未於時限內確認[，,]\s*票券預留失敗\s*OK$/.test(text)) return;
        if (/^抱歉，時間到了！\s*請返回並重新排隊\s*OK$/.test(text)) {
            throw new Error("配位期間排隊過期，交由既有恢復模組核對。");
        }
        throw new PurchaseStop("出現尚未支援的配位提示，已停止；不自動關閉或換區。");
    }

    private async isPanelVisible(): Promise<boolean> {
        const count = await this.panel.count();
        if (count > 1) throw new Error("選位彈窗不唯一，已停止。");
        return count === 1 && await this.panel.isVisible();
    }

    private readSeatResult(): Promise<SeatResult> {
        // 一次讀取同一份 DOM，避免各欄位取到不同時間的配位狀態。
        return this.panel.evaluate((element, s): SeatResult => {
            const list = element.querySelector(s.list);
            const seats = Array.from(list?.querySelectorAll(s.seat) ?? []).map(row => {
                const values = Array.from(row.querySelectorAll("ins"), value => value.textContent?.trim() ?? "");
                return { section: values[0] ?? "", row: values[1] ?? "", number: values[2] ?? "" };
            });
            return {
                text: (element as HTMLElement).innerText,
                area: list?.querySelector(s.area)?.textContent ?? "",
                total: list?.querySelector(s.total)?.textContent ?? "",
                seats,
            };
        }, selectors);
    }

    private async throwIfSeatReservationExpired(): Promise<void> {
        // 提示在座位清單外；先停止操作，恢復模組再嚴格確認彈窗。
        const notices = this.page.getByText(/未於時限內確認[，,]\s*票券預留失敗/);
        for (const notice of await notices.all()) {
            if (await notice.isVisible()) {
                throw new SeatExpiredBeforeConfirmationError("票券預留已到期，已停止確認；僅在符合恢復條件時重新配位。");
            }
        }
    }

    private throwIfSeatError(text: string): void {
        if (/選位失敗|已逾時|已超時|時間已到/.test(text)) {
            throw new PurchaseStop("選位畫面顯示失敗或逾時，請人工檢查；未判定售罄。");
        }
    }

    private async isConfirmReady(): Promise<boolean> {
        const confirm = this.panel.getByRole("button", { name: "確認", exact: true });
        return await confirm.count() === 1 && await confirm.isVisible() && await confirm.isEnabled();
    }

    private logResult(result: SeatResult): void {
        const seats = result.seats.map(seat => `${seat.section}區 / ${seat.row}排 / ${seat.number}號`).join("、");
        log(`配位核對完成：${seats}`);
        log("配位結果已核對，目前尚未按確認。");
    }
}
