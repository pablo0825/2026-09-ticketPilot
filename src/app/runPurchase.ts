import { acquirePurchaseLease, verifyPurchaseLease, releasePurchaseLease, type PurchaseLease } from "./purchaseLock.js";
import { validatePurchaseConfig } from "../core/purchaseValidation.js";
import { FlowPause } from "../core/flowPause.js";
import { KlookSeatRecovery, KlookContactRecovery, KlookQueueRecovery } from "../platforms/klook/expiryRecovery.js";
import { PaymentPageError, waitForPaymentPage } from "../platforms/klook/paymentPage.js";
import { validateContactDetails, type ContactDetails } from "../config/contact.config.js";
import { KlookContactForm } from "../platforms/klook/contactForm.js";
import { readBookingSummary, verifyBookingSummary } from "../platforms/klook/bookingSummary.js";
import { prepareBooking } from "../core/bookingPreparation.js";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { isKlookUrl, prepareStartup } from "../platforms/klook/startup.js";
import type { PurchaseConfig } from "../core/types.js";
import { log, withRunEvents, type RunEvent } from "../core/logger.js";
import { projectRoot } from "../config/activityStore.js";
import { PriorityStrategy } from "../core/priorityStrategy.js";
import { collectStoppedDiagnostics } from "../core/stoppedDiagnostics.js";
import { captureSelectionDiagnostics } from "../platforms/klook/selectionDiagnostics.js";
import { KlookTargetAttempt } from "../platforms/klook/targetAttempt.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { reportState } from "../core/state.js";
import { waitForPersonalInfoPage } from "../platforms/klook/personalInfoPage.js";

async function openEventPage(
    config: PurchaseConfig,
    onBrowser?: (context: import("playwright").BrowserContext) => void,
): Promise<Page> {
    const eventUrlString = config.eventUrl;
    if (!isKlookUrl(eventUrlString)) {
        throw new Error("活動網址必須是 Klook 的 HTTPS 網址。");
    }

    // 僅在明確啟用時調整，方便回到原設定作對照。
    const webdriverExperiment = process.env.WEBDRIVER_EXPERIMENT === "1";

    log(`自動化識別參數測試：${webdriverExperiment ? "開啟" : "關閉"}`);

    // 啟動瀏覽器，將 cookie, 登入狀態存在 ./browser-profile
    const context = await chromium.launchPersistentContext(join(projectRoot, "browser-profile"), {
        channel: "chrome",
        headless: false,
        // 啟用沙箱隔離
        chromiumSandbox: true,
        // 調整與自動化有關的瀏覽器參數
        args: webdriverExperiment ? ["--disable-blink-features=AutomationControlled"] : [],
    });

    onBrowser?.(context);

    // 優先使用 persistent context 已開啟的分頁。
    const page = context.pages()[0] ?? (await context.newPage());

    // 讀取瀏覽器的 navigator.webdriver，並打印結果
    log(`啟動頁 navigator.webdriver： ${await page.evaluate(() => navigator.webdriver)}`);

    await prepareStartup(page, eventUrlString, { saleSchedule: config.saleSchedule });
    return page;
}

async function submitAndVerifyPayment(
    page: Page,
    eventUrl: string,
    contactForm: KlookContactForm,
    expectedTotal: number,
): Promise<void> {
    reportState("CONTACT_SUBMISSION");
    await contactForm.submit();
    try {
        await waitForPaymentPage(page, eventUrl, expectedTotal);
    } catch (error) {
        const reason = error instanceof PaymentPageError ? error.message : "付款頁核對發生未知錯誤。";
        throw new Error(`已嘗試提交，但未能核對付款頁：${reason} 請人工檢查頁面及訂單；不會重新提交或重跑購票。`);
    }
    reportState("PAYMENT_READY");
    log("已核對付款頁與金額，停在付款前；不會按確認付款。");
}

export interface PurchaseRunOptions {
    onEvent?: (event: RunEvent) => void;
    onBrowser?: (context: import("playwright").BrowserContext) => void;
    pause?: string;
    lease?: PurchaseLease;
}

export async function runPurchase(
    config: PurchaseConfig,
    contact: ContactDetails,
    options: PurchaseRunOptions = {},
): Promise<void> {
    const snapshot = structuredClone(config);
    const details = validateContactDetails(contact);
    // 前置資料驗證失敗時不取得瀏覽器占用。
    validatePurchaseConfig(snapshot);
    const lease = options.lease ?? acquirePurchaseLease();
    verifyPurchaseLease(lease);
    let settled = false;
    let browserClosed = true;
    let released = false;
    const release = () => {
        if (settled && browserClosed && !released) {
            releasePurchaseLease(lease);
            released = true;
        }
    };
    try {
        await withRunEvents(options.onEvent ?? (() => {}), () =>
            executePurchase(snapshot, details, {
                ...options,
                onBrowser: context => {
                    browserClosed = false;
                    context.once("close", () => {
                        browserClosed = true;
                        release();
                    });
                    options.onBrowser?.(context);
                },
            }),
        );
    } finally {
        settled = true;
        release();
    }
}

async function executePurchase(
    eventConfig: PurchaseConfig,
    contactDetails: ContactDetails,
    options: PurchaseRunOptions,
) {
    // 顯示 status 為正在啟動
    reportState("STARTING");
    // 驗證活動資料是否符合規定
    const strategy = new PriorityStrategy(eventConfig);
    const pause = new FlowPause(options.pause);

    for (const [index, target] of eventConfig.targets.entries()) {
        log(`順位 ${index + 1}：${target.date} ${target.time} / ${target.area} / ${target.quantity} 張`);
    }
    const page = await openEventPage(eventConfig, options.onBrowser);

    // 啟動檢查完成；已知排隊過期仍由下方既有恢復流程處理。
    const contactForm = new KlookContactForm(page, eventConfig.eventUrl);
    let selecting = false;
    const prepared = await prepareBooking(
        {
            selectSeats: async () => {
                selecting = true;
                return strategy.select(new KlookTargetAttempt(page, eventConfig.eventUrl));
            },
            confirmSeats: async ({ target, value: { seatSelector, allocation } }) => {
                selecting = false;
                reportState("SEATS_VERIFIED");
                await pause.waitAt("seats");
                reportState("SEAT_CONFIRMATION");
                await seatSelector.confirmVerifiedSeats(target, allocation);
                await waitForPersonalInfoPage(page, eventConfig.eventUrl);
                reportState("PERSONAL_INFO_READY");
            },
            prepareContact: async ({ target, value: { allocation } }) => {
                const bookingExpectation = target.expectation;
                const summary = await readBookingSummary(page, eventConfig.eventUrl);
                verifyBookingSummary(summary, target, allocation, bookingExpectation);
                reportState("BOOKING_VERIFIED");
                reportState("CONTACT_FILLING");
                await contactForm.fillAndVerify(contactDetails);
                verifyBookingSummary(
                    await readBookingSummary(page, eventConfig.eventUrl),
                    target,
                    allocation,
                    bookingExpectation,
                );
                await contactForm.verify(contactDetails);
                reportState("CONTACT_VERIFIED");
                if (await pause.waitAt("contact")) {
                    // 暫停期間可能過期或被修改，返回前重新核對；仍在恢復範圍內。
                    verifyBookingSummary(
                        await readBookingSummary(page, eventConfig.eventUrl),
                        target,
                        allocation,
                        bookingExpectation,
                    );
                    await contactForm.verify(contactDetails);
                }
            },
        },
        new KlookQueueRecovery(page, eventConfig.eventUrl),
        new KlookContactRecovery(page, eventConfig.eventUrl),
        new KlookSeatRecovery(page, eventConfig.eventUrl),
    ).catch(async (error: unknown) => {
        // 已離開 recovery 範圍；採集失敗或手動返回都不能再次購買。
        if (selecting && !(error instanceof Error && error.name === "AbortError")) {
            reportState("MANUAL_REQUIRED");
            const directory = join(projectRoot, "diagnostics", randomUUID());
            log(`購買已停止，診斷目錄：${directory}`);
            await collectStoppedDiagnostics(label =>
                captureSelectionDiagnostics(page, eventConfig.eventUrl, directory, label),
            );
        }
        throw error;
    });

    // 提交永遠在恢復範圍外；即使此刻才到期，也停止而不冒險重送。
    await submitAndVerifyPayment(page, eventConfig.eventUrl, contactForm, prepared.target.expectation.totalPrice);
    log("操作結束後，請關閉瀏覽器視窗。");
}
