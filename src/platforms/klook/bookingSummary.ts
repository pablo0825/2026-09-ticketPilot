import { isPersonalInfoPage } from "./personalInfoPage.js";
import { validateBookingExpectation } from "../../core/purchaseValidation.js";
import type { Page } from "playwright";
import type { TicketTarget, BookingExpectation } from "../../core/types.js";
import { seatKey, type AssignedSeat } from "./seatSelector.js";

export interface BookingSummary {
    eventName: string;
    packageName: string;
    dateTime: string;
    quantity: string;
    seatLabels: string[];
    total: string;
}

const normalizeText = (text: string): string => text.normalize("NFKC").replace(/\s+/g, "").trim();

function parseAmount(text: string): number {
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error("摘要金額格式無法辨識。");
    const amount = Number(text.replace(/,/g, ""));
    if (!Number.isSafeInteger(amount)) throw new Error("摘要金額超出可核對範圍。");
    return amount;
}

// 純核對函式：不讀 DOM、不點按鈕，任何不符均拋錯。
export function verifyBookingSummary(summary: BookingSummary, target: TicketTarget,
    expectedSeats: AssignedSeat[], expected: BookingExpectation): void {
    validateBookingExpectation(expected);
    if (normalizeText(summary.eventName) !== normalizeText(expected.eventName)) throw new Error("預訂摘要活動名稱不符。");
    if (normalizeText(summary.dateTime) !== `${target.date}${target.time}:00`) throw new Error("預訂摘要日期或時間不符。");
    verifyPrices(summary, target.area, expected);
    if (normalizeText(summary.quantity) !== String(target.quantity)) throw new Error("預訂摘要張數不符。");
    verifySeats(summary.seatLabels, expectedSeats, target.quantity);
}

function verifyPrices(summary: BookingSummary, area: string, expected: BookingExpectation): void {
    const packageMatch = normalizeText(summary.packageName).match(/^(.+)\(NT\$([\d,]+)\)$/);
    if (!packageMatch || packageMatch[1] !== normalizeText(area)) throw new Error("預訂摘要票種不符或格式未知。");
    if (parseAmount(packageMatch[2]!) !== expected.unitPrice) throw new Error("預訂摘要單價不符。");
    const totalMatch = normalizeText(summary.total).match(/^NT\$([\d,]+)$/);
    if (!totalMatch || parseAmount(totalMatch[1]!) !== expected.totalPrice) throw new Error("預訂摘要總價不符。");
}

function parseSeat(label: string): AssignedSeat {
    const match = normalizeText(label).match(/^(.+)區,第(.+)排,(.+)號座位$/);
    if (!match) throw new Error("預訂摘要座位格式未知，已停止核對。");
    return { section: match[1]!, row: match[2]!, number: match[3]! };
}

function verifySeats(labels: string[], expectedSeats: AssignedSeat[], quantity: number): void {
    // 排序後比對，使 DOM 的排列順序不影響結果；重複座位仍視為錯誤。
    const actual = labels.map(parseSeat).map(seatKey).sort();
    const wanted = expectedSeats.map(seatKey).sort();
    if (actual.length !== quantity || wanted.length !== quantity ||
        new Set(actual).size !== actual.length || new Set(wanted).size !== wanted.length ||
        JSON.stringify(actual) !== JSON.stringify(wanted)) {
        throw new Error("預訂摘要座位與已確認配位不符。");
    }
}

async function assertPageAvailable(page: Page, eventUrl: string): Promise<void> {
    if (!isPersonalInfoPage(page.url(), eventUrl)) {
        throw new Error("目前不在預期的個人資料頁。");
    }
    if (await page.locator(".klk-modal").filter({ visible: true }).count() > 0) {
        throw new Error("個人資料頁有彈窗，請先人工檢查；不判定摘要有效。");
    }
}

// 只讀取唯一可見的摘要容器，不讀聯絡資料或輸入值。
export async function readBookingSummary(page: Page, eventUrl: string): Promise<BookingSummary> {
    await assertPageAvailable(page, eventUrl);
    const product = page.locator(".product").filter({ has: page.locator("h2.product_name"), visible: true });
    await product.waitFor({ state: "visible", timeout: 10_000 });
    if (await product.count() !== 1) throw new Error("預訂摘要不唯一。");
    const fields = await product.evaluate(element => ({
        names: Array.from(element.querySelectorAll("h2.product_name"), el => (el as HTMLElement).innerText.trim()),
        packages: Array.from(element.querySelectorAll(".product_package_name"), el => (el as HTMLElement).innerText.trim()),
        rows: Array.from(element.querySelectorAll(".main .item"), row => ({
            labels: Array.from(row.querySelectorAll(".item_label"), el => (el as HTMLElement).innerText.trim()),
            values: Array.from(row.querySelectorAll(".item_value"), el => (el as HTMLElement).innerText.trim()),
        })),
        totals: Array.from(element.querySelectorAll("footer .item_value"), el => (el as HTMLElement).innerText.trim()),
    }));
    const summary = parseSummaryFields(fields);
    await assertPageAvailable(page, eventUrl);
    return summary;
}

interface SummaryFields {
    names: string[];
    packages: string[];
    rows: { labels: string[]; values: string[] }[];
    totals: string[];
}

function requireSingleValue(values: string[], label: string): string {
    if (values.length !== 1 || !values[0]) throw new Error(`預訂摘要${label}缺少或重複。`);
    return values[0];
}
function labeledValue(fields: SummaryFields, label: RegExp): string {
    const rows = fields.rows.filter(row => row.labels.some(text => label.test(text)));
    if (rows.length !== 1 || rows[0]!.labels.length !== 1) throw new Error("預訂摘要標籤缺少或重複。");
    return requireSingleValue(rows[0]!.values, "標籤值");
}

function parseSummaryFields(fields: SummaryFields): BookingSummary {
    return {
        eventName: requireSingleValue(fields.names, "活動名稱"),
        packageName: requireSingleValue(fields.packages, "票種"),
        dateTime: labeledValue(fields, /^日期$/),
        quantity: labeledValue(fields, /^門票[（(]不含全家取票手續費NT\$30\/每筆[）)]$/),
        seatLabels: fields.rows.filter(row => row.labels.length === 0).map(row => requireSingleValue(row.values, "座位")),
        total: requireSingleValue(fields.totals, "總價"),
    };
}
