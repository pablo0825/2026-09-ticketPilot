import { loadContactDetails } from "./config/contact.config.js";
import { KlookContactForm } from "./platforms/klook/contactForm.js";
import { readBookingSummary, verifyBookingSummary, validateBookingExpectation } from "./platforms/klook/bookingSummary.js";
import { runWithRecovery } from "./core/recovery.js";
import { KlookQueueRecovery } from "./platforms/klook/queueRecovery.js";
import { chromium } from "playwright";
import { eventConfig, bookingExpectation } from "./config/event.config.js";
import { runSelection } from "./core/strategy.js";
import { reportState } from "./core/state.js";
import { KlookTicketSelector } from "./platforms/klook/ticketSelector.js";
import { KlookSeatSelector } from "./platforms/klook/seatSelector.js";
import { waitForPersonalInfoPage } from "./platforms/klook/personalInfoPage.js";

async function main() {
    // 顯示 status 為正在啟動
    reportState("STARTING");
    // 驗證活動資料是否符合規定
    validateBookingExpectation(bookingExpectation);

    // 載入個人資料
    const contactDetails = await loadContactDetails();
    // 取出購票資訊
    const target = eventConfig.targets[0];
    
    // 檢查購票資訊是否存在
    if (!target) throw new Error("請先在 event.config.ts 設定目標票券。");
    // 取出購票資訊中的活動網址的 URL

    const eventUrl = new URL(eventConfig.eventUrl);
    // 不是 https，或不是 klook.com 就拒絕
    if (eventUrl.protocol !== "https:" ||
        // .endWith() 判斷字串是否以指定的字串結尾，回傳 boolean
        !(eventUrl.hostname === "klook.com" || eventUrl.hostname.endsWith(".klook.com"))) {
        throw new Error("活動網址必須是 Klook 的 HTTPS 網址。");
    }

    console.log(`目標：${target.date} ${target.time} / ${target.area} / ${target.quantity} 張`);
    
    // 僅在明確啟用時調整，方便回到原設定作對照。
    // 1 為 true, 0 為 false
    // 某個功能的開關
    const webdriverExperiment = process.env.WEBDRIVER_EXPERIMENT === "1";

    console.log(`自動化識別參數測試：${webdriverExperiment ? "開啟" : "關閉"}`);
    
    // 啟動瀏覽器，將 cookie, 登入狀態存在 ./browser-profile
    // await 等跑完再把資料存到 context
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
    const response = await page.goto(eventConfig.eventUrl, {
        // 程式到那一步才可以繼續
        // 收到 html, 建立 dom, 就可以繼續，網頁會繼續載入圖片
        waitUntil: "domcontentloaded",
    });

    console.log(`活動頁導覽 HTTP 狀態：${response?.status() ?? "未知"}`);

    if (response?.status() === 403) {
        reportState("MANUAL_REQUIRED");
        console.error("活動頁存取被拒絕；請查看瀏覽器是否提供人工驗證或顯示封鎖頁。");
        console.log("程式不會自動重試。檢查完成後請關閉瀏覽器。");
        return;
    }
    if (!response || !response.ok()) {
        throw new Error(`活動頁載入失敗：HTTP ${response?.status() ?? "未知"}`);
    }

    // 取得目前瀏覽器的網址
    const currentUrl = new URL(page.url());
    // 分析網址是不是目標活動網址
    if (currentUrl.origin !== eventUrl.origin || currentUrl.pathname !== eventUrl.pathname) {
        reportState("MANUAL_REQUIRED");
        console.log("目前未在目標活動頁，請人工完成登入／驗證後重新執行。");
        return;
    }

    // status 為活動頁面(應該是打開活動頁的意思？)
    reportState("EVENT_PAGE");
    const { seatSelector, seats } = await runWithRecovery(async () => {
        await runSelection(eventConfig, new KlookTicketSelector(page));

        reportState("SEAT_ASSIGNMENT");

        const seatSelector = new KlookSeatSelector(page);
        const seats = await seatSelector.openAndVerify(target);
        
        return { seatSelector, seats };
    }, new KlookQueueRecovery(page, eventConfig.eventUrl));
    
    // 確認及導頁不自動重跑，避免送出結果未知時重複操作。
    reportState("SEATS_VERIFIED");
    reportState("SEAT_CONFIRMATION");
    await seatSelector.confirmVerifiedSeats(target, seats);
    await waitForPersonalInfoPage(page, eventConfig.eventUrl);
    reportState("PERSONAL_INFO_READY");
    const summary = await readBookingSummary(page, eventConfig.eventUrl);
    verifyBookingSummary(summary, target, seats, bookingExpectation);
    reportState("BOOKING_VERIFIED");
    if (contactDetails) {
        reportState("CONTACT_FILLING");
        await new KlookContactForm(page, eventConfig.eventUrl).fillAndVerify(contactDetails);
        verifyBookingSummary(await readBookingSummary(page, eventConfig.eventUrl), target, seats, bookingExpectation);
        reportState("CONTACT_VERIFIED");
        console.log("聯絡資料填寫與欄位核對完成，已停在提交前。請人工確認收據及網站提示；不會前往付款。");
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
