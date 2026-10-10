import { parseTicketLabel, normalizeTicketName, parseTicketAmount } from "./ticketLabel.js";
import { getSelectionNotices, isExpiryNotice, reservationExpiredNotice } from "./notices.js";
import { seatPanelSelector } from "./eventPage.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { SeatExpiredBeforeConfirmationError } from "../../core/seatExpiry.js";
import type { Locator, Page } from "playwright";
import type { TicketTarget } from "../../core/types.js";
import { log } from "../../core/logger.js";
import { seatKey } from "./allocation.js";
import type { Allocation, AssignedSeat } from "./allocation.js";

export interface SeatResult {
    text: string;
    session: string;
    area: string;
    total: string;
    seats: AssignedSeat[];
    selected: string;
    price: string;
    group: string | null;
    structureValid: boolean;
    loading: boolean;
}

// 取自實際選位彈窗；只讀取主頁的配位結果，不操作座位圖 iframe。
const selectors = {
    panel: seatPanelSelector,
    list: ".seat_list-BhwLqz",
    session: ".pc_header_center-mSlDdM > span",
    area: ".seat_list_cat-vMvUjF",
    seat: ".list_item-jYRAN7",
    total: ".con_seats-a3N26U",
    selected: ".seat_list_top-Bk0UC9",
    price: ".con_price-YYYONb",
    rows: ".seat_footer_list-TWhU8V",
};

function normalize(text: string): string {
    return text.normalize("NFKC").replace(/\s/g, "");
}

function checkSession(text: string, target: TicketTarget): string | undefined {
    const [year, month, day] = target.date.split("-").map(Number);
    const [hour, minute] = target.time.split(":").map(Number);

    // 只接受唯一場次欄位的完整文字，不從面板其他日期或倒數中搜尋。
    const match = text
        .normalize("NFKC")
        .trim()
        .match(
            /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:週|星期)[一二三四五六日天]\s*(上午|下午)\s*(\d{1,2}):(\d{2})$/,
        );
    if (!match) return `尚未讀到 ${target.date} 的完整場次資料`;

    // 核對日期
    if (Number(match[1]) !== year || Number(match[2]) !== month || Number(match[3]) !== day) {
        return `日期不符：預期 ${target.date}，實際 ${match[1]}-${match[2]}-${match[3]}`;
    }

    // 把上午／下午換成 24 小時制，再核對時間
    const displayedHour = Number(match[5]);
    const actualMinute = Number(match[6]);
    if (displayedHour < 1 || displayedHour > 12 || actualMinute > 59) return "場次時間格式無法辨識";

    const actualHour = (displayedHour % 12) + (match[4] === "下午" ? 12 : 0);
    if (actualHour !== hour || actualMinute !== minute) {
        const actualTime = `${String(actualHour).padStart(2, "0")}:${String(actualMinute).padStart(2, "0")}`;
        return `時間不符：預期 ${target.time}，實際 ${actualTime}`;
    }

    return undefined;
}

function checkArea(area: string, wanted: string): string | undefined {
    let actual: string;
    try {
        actual = parseTicketLabel(area).name;
    } catch {
        return "票種名稱或價格格式尚未能辨識";
    }

    if (actual !== normalizeTicketName(wanted)) return `票種不符：預期 ${wanted}，實際 ${area.trim() || "尚未出現"}`;
    return undefined;
}

function checkSeats(result: SeatResult, quantity: number): string | undefined {
    if (normalize(result.total) !== `共計${quantity}個座位` || normalize(result.selected) !== `已選${quantity}個座位`) {
        return `座位數標示尚未符合 ${quantity} 張`;
    }
    if (result.group !== null) return undefined;

    if (result.seats.length !== quantity) {
        return `座位明細數量不符：預期 ${quantity} 筆，實際 ${result.seats.length} 筆`;
    }
    if (result.seats.some(seat => !seat.section.trim() || !seat.row.trim() || !seat.number.trim())) {
        return "座位資料不完整：區、排、座號不可缺少";
    }

    const keys = result.seats.map(seatKey);
    if (new Set(keys).size !== quantity) return "座位明細出現重複座位";
    return undefined;
}

// undefined 代表核對通過；字串是尚未符合的原因，不代表售罄。
export function getSeatResultMismatch(result: SeatResult, target: TicketTarget): string | undefined {
    return (
        checkSession(result.session, target) ??
        checkArea(result.area, target.area) ??
        (result.loading ? "配位畫面仍在載入" : undefined) ??
        (!result.structureValid ? "配位欄位缺少、重複或結構未知" : undefined) ??
        checkSeats(result, target.quantity) ??
        (result.group !== null && target.quantity > 1 && target.adjacent ? "一般票彙總無法驗證連位需求" : undefined)
    );
}

function allocationFrom(result: SeatResult, quantity: number): Allocation {
    return result.group === null
        ? { kind: "reserved", seats: result.seats }
        : { kind: "general", group: result.group, quantity };
}

function allocationKey(allocation: Allocation): string {
    return allocation.kind === "reserved"
        ? JSON.stringify([allocation.kind, allocation.seats.map(seatKey).sort()])
        : JSON.stringify([allocation.kind, normalize(allocation.group), allocation.quantity]);
}

export class KlookSeatSelector {
    private readonly panel: Locator;

    constructor(
        private readonly page: Page,
        private readonly expectedUnitPrice: number,
        private readonly timeout = 30_000,
    ) {
        if (!Number.isSafeInteger(expectedUnitPrice) || expectedUnitPrice <= 0) {
            throw new PurchaseStop("預期單價必須是正整數。");
        }

        this.panel = page.locator(selectors.panel);
    }

    async openAndVerify(target: TicketTarget, observeFailure?: () => Promise<void>): Promise<Allocation> {
        await this.openSeatDialog();
        const result = await this.waitForMatchingSeats(target, observeFailure);
        this.logResult(result);
        return allocationFrom(result, target.quantity);
    }

    async confirmVerifiedSeats(target: TicketTarget, expectedAllocation: Allocation): Promise<void> {
        // 確認沒有提示，選位彈窗仍開著
        await this.checkObservationDialog();
        await this.throwIfSeatReservationExpired();
        if (!(await this.isPanelVisible())) throw new Error("選位彈窗已關閉，無法確認。");

        // 點擊前重讀，避免送出已改變的配位結果。
        const result = await this.readSeatResult();
        this.throwIfSeatError(result.text);

        const mismatch = getSeatResultMismatch(result, target);
        if (mismatch) throw new Error(`確認前核對失敗：${mismatch}`);

        this.verifyPrices(result, target.quantity);
        if (allocationKey(allocationFrom(result, target.quantity)) !== allocationKey(expectedAllocation)) {
            throw new PurchaseStop("確認前配位結果已改變，已停止。");
        }

        // 按一次確認
        if (!(await this.isConfirmReady())) throw new Error("確認按鈕目前無法操作，已停止。");
        await this.throwIfSeatReservationExpired();
        await this.panel.getByRole("button", { name: "確認", exact: true }).click({ timeout: this.timeout });
        log("已按選位確認，等待填寫資料頁；不會重複點擊。");
    }

    private verifyPrices(result: SeatResult, quantity: number): void {
        if (parseTicketLabel(result.area).unitPrice !== this.expectedUnitPrice) {
            throw new PurchaseStop("配位票種單價不符，已停止。");
        }

        const match = normalize(result.price).match(/^NT\$([\d,]+)$/);
        if (!match || parseTicketAmount(match[1]!) !== this.expectedUnitPrice * quantity) {
            throw new PurchaseStop("配位總額不符，已停止。");
        }
    }

    private async openSeatDialog(): Promise<void> {
        if (await this.isPanelVisible()) throw new Error("已有選位彈窗，請先人工確認目前狀態。");
        const next = this.page.locator("#ticket-options").getByRole("button", { name: "下一步", exact: true });
        await next.click({ timeout: this.timeout }); // 只點一次，後續只讀取 DOM。
    }

    private async waitForMatchingSeats(
        target: TicketTarget,
        observeFailure?: () => Promise<void>,
    ): Promise<SeatResult> {
        const deadline = Date.now() + this.timeout;
        let lastReason = "選位彈窗尚未出現";

        while (Date.now() < deadline) {
            // 先檢查失敗、過期或其他提示
            await observeFailure?.();
            await this.checkObservationDialog();
            await this.throwIfSeatReservationExpired();

            // 讀取配位結果；符合目標、價格正確且確認按鈕可用才回傳
            if (await this.isPanelVisible()) {
                const result = await this.readSeatResult();
                this.throwIfSeatError(result.text);
                const mismatch = getSeatResultMismatch(result, target);
                if (mismatch) lastReason = mismatch;
                else if (await this.isConfirmReady()) {
                    this.verifyPrices(result, target.quantity);
                    return result;
                } else lastReason = "確認按鈕尚未可操作或不唯一";
            } else {
                lastReason = "選位彈窗尚未出現或已關閉";
            }

            await this.page.waitForTimeout(200);
        }

        throw new PurchaseStop(`等待配位結果逾時：${lastReason}；狀態未知，未判定售罄。`);
    }

    private async checkObservationDialog(): Promise<void> {
        const notices = await getSelectionNotices(this.page);
        if (notices.length === 0) return;
        if (notices.length !== 1) throw new PurchaseStop("配位時出現多個提示，已停止操作。");

        const text = (await notices[0]!.innerText()).trim();
        if (isExpiryNotice(text, "reservation")) return;
        if (isExpiryNotice(text, "queue")) {
            throw new Error("配位期間排隊過期，交由既有恢復模組核對。");
        }

        throw new PurchaseStop("出現尚未支援的配位提示，已停止；不自動關閉或換區。");
    }

    private async isPanelVisible(): Promise<boolean> {
        const count = await this.panel.count();
        if (count > 1) throw new Error("選位彈窗不唯一，已停止。");
        return count === 1 && (await this.panel.isVisible());
    }

    private readSeatResult(): Promise<SeatResult> {
        // 一次讀取同一份 DOM，避免各欄位取到不同時間的配位狀態。
        return this.panel.evaluate((element, s): SeatResult => {
            // 找出各欄位；每個欄位都必須剛好一個
            const [list, area, total, selected, price, rows, session] = [
                s.list,
                s.area,
                s.total,
                s.selected,
                s.price,
                s.rows,
                s.session,
            ].map(selector => {
                const matches = element.querySelectorAll(selector);
                return matches.length === 1 ? matches[0]! : null;
            });

            // 已選張數與「自行選位」按鈕同在 top；只讀唯一的張數子欄位。
            const selectedCounts = selected?.querySelectorAll(":scope > div > div");
            const selectedCount = selectedCounts?.length === 1 ? selectedCounts[0]! : null;
            let structureValid = Boolean(
                list &&
                [area, total, selected, selectedCount, price, rows].every(field => field && list.contains(field)),
            );

            const seats: AssignedSeat[] = [];
            let group: string | null = null;
            const items = Array.from(element.querySelectorAll(s.seat));
            if (items.length === 0) structureValid = false;

            // 確認所有欄位都真的顯示在畫面上
            // textContent 也會包含隱藏資料；每列、欄位及值都必須實際顯示。
            const requiredNodes = [
                list,
                area,
                total,
                selected,
                selectedCount,
                price,
                rows,
                session,
                ...items.flatMap(item => [item, ...item.querySelectorAll("span, ins")]),
            ];
            for (const node of requiredNodes) {
                if (!node || node.getClientRects().length === 0) {
                    structureValid = false;
                    continue;
                }

                // opacity 不會繼承到子元素的 computed style，需沿祖先檢查。
                for (let ancestor: Element | null = node; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor);
                    if (
                        style.display === "none" ||
                        style.visibility === "hidden" ||
                        style.visibility === "collapse" ||
                        Number(style.opacity) === 0
                    ) {
                        structureValid = false;
                    }
                }
            }

            // 逐列讀出座位，或只有區欄位的非對號配位
            for (const item of items) {
                if (!rows?.contains(item)) structureValid = false;
                const fields = Array.from(item.querySelectorAll("span"));
                const labels = fields.map(field =>
                    Array.from(field.childNodes)
                        .filter(node => node.nodeType === Node.TEXT_NODE)
                        .map(node => node.textContent)
                        .join("")
                        .trim(),
                );
                const values = fields.map(field => field.querySelector("ins")?.textContent?.trim() ?? "");

                // 拒絕每欄多個值、欄外多餘值，以及列內額外文字。
                const exactFields =
                    fields.every(field => field.querySelectorAll("ins").length === 1 && field.children.length === 1) &&
                    item.querySelectorAll("ins").length === fields.length &&
                    (item.textContent ?? "").replace(/\s/g, "") ===
                        fields
                            .map(field => field.textContent ?? "")
                            .join("")
                            .replace(/\s/g, "");

                if (exactFields && labels.join("/") === "區/排/座位") {
                    seats.push({ section: values[0]!, row: values[1]!, number: values[2]! });
                } else if (
                    exactFields &&
                    items.length === 1 &&
                    labels.join("/") === "區" &&
                    values[0] !== undefined &&
                    values[0].normalize("NFKC").replace(/\s/g, "") !== ""
                ) {
                    group = values[0];
                } else structureValid = false;
            }

            // 檢查座位圖是否仍在載入
            // seatsio 的 hide 仍有尺寸且 display:flex，必須連同 opacity 判讀。
            const shell = element.closest(".seatModal_main-Dpti0D") ?? element;
            const loading = Array.from(shell.querySelectorAll(".seatsio-loading-screen, [aria-busy='true']")).some(
                loader => {
                    const style = getComputedStyle(loader);
                    return (
                        style.display !== "none" &&
                        style.visibility !== "hidden" &&
                        Number(style.opacity) !== 0 &&
                        loader.getClientRects().length > 0
                    );
                },
            );

            return {
                text: (element as HTMLElement).innerText,
                session: session?.textContent ?? "",
                area: area?.textContent ?? "",
                total: total?.textContent ?? "",
                selected: selectedCount?.textContent ?? "",
                price: price?.textContent ?? "",
                seats,
                group,
                structureValid,
                loading,
            };
        }, selectors);
    }

    private async throwIfSeatReservationExpired(): Promise<void> {
        // 提示在座位清單外；先停止操作，恢復模組再嚴格確認彈窗。
        const notices = this.page.getByText(reservationExpiredNotice);
        for (const notice of await notices.all()) {
            if (await notice.isVisible()) {
                throw new SeatExpiredBeforeConfirmationError(
                    "票券預留已到期，已停止確認；僅在符合恢復條件時重新配位。",
                );
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
        return (await confirm.count()) === 1 && (await confirm.isVisible()) && (await confirm.isEnabled());
    }

    private logResult(result: SeatResult): void {
        const seats = result.seats.map(seat => `${seat.section}區 / ${seat.row}排 / ${seat.number}號`).join("、");

        log(
            `配位核對完成：${result.group === null ? seats : `${result.group}／${result.total.trim()}／${result.price.trim()}`}`,
        );
        log("配位結果已核對，目前尚未按確認。");
    }
}
