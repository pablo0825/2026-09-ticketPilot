import { FlowPause } from "./core/flowPause.js";
import { KlookSeatRecovery, KlookContactRecovery, KlookQueueRecovery } from "./platforms/klook/expiryRecovery.js";
import { PaymentPageError, waitForPaymentPage } from "./platforms/klook/paymentPage.js";
import { loadContactDetails } from "./config/contact.config.js";
import { KlookContactForm } from "./platforms/klook/contactForm.js";
import { readBookingSummary, verifyBookingSummary } from "./platforms/klook/bookingSummary.js";
import { prepareBooking } from "./core/bookingPreparation.js";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { isEventPage } from "./platforms/klook/eventPage.js";
import { eventConfig } from "./config/event.config.js";
import { PriorityStrategy } from "./core/priorityStrategy.js";
import { collectStoppedDiagnostics } from "./core/stoppedDiagnostics.js";
import { captureSelectionDiagnostics } from "./platforms/klook/selectionDiagnostics.js";
import { KlookTargetAttempt } from "./platforms/klook/targetAttempt.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { reportState } from "./core/state.js";
import { waitForPersonalInfoPage } from "./platforms/klook/personalInfoPage.js";

async function openEventPage(eventUrlString: string): Promise<Page | null> {
    const eventUrl = new URL(eventUrlString);
    if (eventUrl.protocol !== "https:" ||
        !(eventUrl.hostname === "klook.com" || eventUrl.hostname.endsWith(".klook.com"))) {
        throw new Error("活動網址必須是 Klook 的 HTTPS 網址。");
    }

    // 僅在明確啟用時調整，方便回到原設定作對照。
    const webdriverExperiment = process.env.WEBDRIVER_EXPERIMENT === "1";

    console.log(`自動化識別參數測試：${webdriverExperiment ? "開啟" : "關閉"}`);

    // 啟動瀏覽器，將 cookie, 登入狀態存在 ./browser-profile
    const context = await chromium.launchPersistentContext("./browser-profile", {
        channel: "chrome",
        headless: false,
        // 啟用沙箱隔離
        chromiumSandbox: true,
        // 調整與自動化有關的瀏覽器參數
        args: webdriverExperiment ? ["--disable-blink-features=AutomationControlled"] : [],
    });

    // 優先使用 persistent context 已開啟的分頁。
    const page = context.pages()[0] ?? await context.newPage();

    // 讀取瀏覽器的 navigator.webdriver，並打印結果
    console.log("啟動頁 navigator.webdriver：", await page.evaluate(() => navigator.webdriver));

    // 前往活動網址
    const response = await page.goto(eventUrlString, {
        waitUntil: "domcontentloaded",
    });

    console.log(`活動頁導覽 HTTP 狀態：${response?.status() ?? "未知"}`);

    if (response?.status() === 403) {
        reportState("MANUAL_REQUIRED");
        console.error("活動頁存取被拒絕；請查看瀏覽器是否提供人工驗證或顯示封鎖頁。");
        console.log("程式不會自動重試。檢查完成後請關閉瀏覽器。");
        return null;
    }
    if (!response || !response.ok()) {
        throw new Error(`活動頁載入失敗：HTTP ${response?.status() ?? "未知"}`);
    }

    if (!isEventPage(page.url(), eventUrlString)) {
        reportState("MANUAL_REQUIRED");
        console.log("目前未在目標活動頁，請人工完成登入／驗證後重新執行。");
        return null;
    }
    return page;
}

async function submitAndVerifyPayment(page: Page, eventUrl: string,
    contactForm: KlookContactForm, expectedTotal: number): Promise<void> {
    reportState("CONTACT_SUBMISSION");
    await contactForm.submit();
    try {
        await waitForPaymentPage(page, eventUrl, expectedTotal);
    } catch (error) {
        const reason = error instanceof PaymentPageError ? error.message : "付款頁核對發生未知錯誤。";
        throw new Error(`已嘗試提交，但未能核對付款頁：${reason} 請人工檢查頁面及訂單；不會重新提交或重跑購票。`);
    }
    reportState("PAYMENT_READY");
    console.log("已核對付款頁與金額，停在付款前；不會按確認付款。");
}

async function main() {
    // 顯示 status 為正在啟動
    reportState("STARTING");
    // 驗證活動資料是否符合規定
    const strategy = new PriorityStrategy(eventConfig);
    const pause = new FlowPause(process.env.FLOW_PAUSE);

    // 載入個人資料
    const contactDetails = await loadContactDetails();
    if (process.env.FLOW_PAUSE === "contact" && !contactDetails) {
        throw new Error("FLOW_PAUSE=contact 需要先設定 contact.local.json。");
    }
    for (const [index, target] of eventConfig.targets.entries()) {
        console.log(`順位 ${index + 1}：${target.date} ${target.time} / ${target.area} / ${target.quantity} 張`);
    }
    const page = await openEventPage(eventConfig.eventUrl);
    if (!page) return;

    // 活動頁已到達，接著核對選票入口與目標。
    reportState("EVENT_PAGE");
    const contactForm = new KlookContactForm(page, eventConfig.eventUrl);
    let selecting = false;
    const prepared = await prepareBooking({
        selectSeats: async () => {
            selecting = true;
            return strategy.select(new KlookTargetAttempt(page, eventConfig.eventUrl));
        },
        confirmSeats: async ({ target, value: { seatSelector, seats } }) => {
            selecting = false;
            reportState("SEATS_VERIFIED");
            await pause.waitAt("seats");
            reportState("SEAT_CONFIRMATION");
            await seatSelector.confirmVerifiedSeats(target, seats);
            await waitForPersonalInfoPage(page, eventConfig.eventUrl);
            reportState("PERSONAL_INFO_READY");
        },
        prepareContact: async ({ target, value: { seats } }) => {
            const bookingExpectation = target.expectation;
            const summary = await readBookingSummary(page, eventConfig.eventUrl);
            verifyBookingSummary(summary, target, seats, bookingExpectation);
            reportState("BOOKING_VERIFIED");
            if (contactDetails) {
                reportState("CONTACT_FILLING");
                await contactForm.fillAndVerify(contactDetails);
                verifyBookingSummary(await readBookingSummary(page, eventConfig.eventUrl), target, seats, bookingExpectation);
                await contactForm.verify(contactDetails);
                reportState("CONTACT_VERIFIED");
                if (await pause.waitAt("contact")) {
                    // 暫停期間可能過期或被修改，返回前重新核對；仍在恢復範圍內。
                    verifyBookingSummary(await readBookingSummary(page, eventConfig.eventUrl), target, seats, bookingExpectation);
                    await contactForm.verify(contactDetails);
                }
            }
        },
    }, new KlookQueueRecovery(page, eventConfig.eventUrl), new KlookContactRecovery(page, eventConfig.eventUrl),
        new KlookSeatRecovery(page, eventConfig.eventUrl)).catch(async (error: unknown) => {
        // 已離開 recovery 範圍；採集失敗或手動返回都不能再次購買。
        if (selecting && !(error instanceof Error && error.name === "AbortError")) {
            reportState("MANUAL_REQUIRED");
            const directory = join("diagnostics", randomUUID());
            console.log(`購買已停止，診斷目錄：${directory}`);
            await collectStoppedDiagnostics(label => captureSelectionDiagnostics(page, eventConfig.eventUrl, directory, label));
        }
        throw error;
    });

    // 提交永遠在恢復範圍外；即使此刻才到期，也停止而不冒險重送。
    if (contactDetails) {
        await submitAndVerifyPayment(page, eventConfig.eventUrl, contactForm, prepared.target.expectation.totalPrice);
    } else {
        console.log("摘要核對通過。未提供 contact.local.json，停在個人資料頁。");
    }
    console.log("操作結束後，請關閉瀏覽器視窗。");
}

main().catch((error: unknown) => {
    reportState("FAILED");
    console.error("流程已停止：", error);
    console.log("請保留畫面供檢查；不會自動重新整理或嘗試其他票種。");
    process.exitCode = 1;
});
