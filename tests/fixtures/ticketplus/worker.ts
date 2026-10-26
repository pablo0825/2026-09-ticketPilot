import { applicationActivity as activity, installFixtureSessionNavigation } from "./sessionNavigation.js";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { writeFile, readFile, rename } from "node:fs/promises";
import { appendFileSync, watchFile, unwatchFile } from "node:fs";
import { student, presale, soldOut, checkout } from "./pages.js";
import { readyOrder, readyInformation, failureDialog, queueDialog } from "./submissionPage.js";
import { lotteryInputPage, registerPage } from "./lotteryPages.js";

// 只替換瀏覽器環境，正式 worker、runner、DOM 模組與設定解析均照常執行。
let context: BrowserContext | undefined;
const report = process.env.FIXTURE_REPORT!;
appendFileSync(report + ".starts", "started\n");
const mode = process.env.FIXTURE_MODE ?? "success";
const counts = { session: 0, plus: 0, submit: 0, dismiss: 0, information: 0, other: 0, terms: 0 };
const requests: string[] = [];
const timeline: { kind: string; at: number }[] = [];
const loggedOutHome = '<header class="headerApp"><button>會員登入</button></header>';
async function loginFixture() {
    await context?.pages()[0]?.evaluate(() => {
        document.querySelector("header.headerApp")!.innerHTML =
            '<div class="font-weight-bold">0987***654 <span class="cursor-pointer">登出</span></div>';
    });
}
let releaseLaunch: (() => void) | undefined;
const submissions: { name: string; quantity: number }[][] = [];
let flush = Promise.resolve();
function save() {
    const json = JSON.stringify({ counts, requests, submissions, timeline });
    flush = flush.then(async () => {
        await writeFile(report + ".tmp", json);
        await rename(report + ".tmp", report);
    });
    return flush;
}
chromium.launchPersistentContext = async (_profile, options) => {
    await writeFile(
        report + ".options",
        JSON.stringify({ args: options?.args, channel: options?.channel, profile: _profile }),
    );
    if (mode === "held-launch")
        await new Promise<void>(resolve => {
            releaseLaunch = resolve;
        });
    const browser = await chromium.connect(process.env.FIXTURE_BROWSER_ENDPOINT!);
    context = await browser.newContext();
    // 正式 persistent context 會帶有初始分頁。
    await context.newPage();
    await context.exposeBinding(
        "recordFixture",
        async ({ page }, key: keyof typeof counts, tickets?: { name: string; quantity: number }[]) => {
            if (key === "submit" && tickets) submissions.push(tickets);
            counts[key]++;
            timeline.push({ kind: key, at: Date.now() });
            await save();
            if (key === "submit" && mode === "close-after-submit") await page.close();
        },
    );
    const order =
        mode === "cycle-all-sold-out"
            ? readyOrder
                  .replace(student, soldOut.replace("身障票", "學生票"))
                  .replace(presale.replace("<div>1</div>", "<div>2</div>"), soldOut.replace("身障票", "預售票"))
            : readyOrder.replace("<div>2</div>", "<div>0</div>");
    await context.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        timeline.push({ kind: path, at: Date.now() });
        await save();
        await route.fulfill({
            contentType: "text/html; charset=utf-8",
            body:
                path === "/order/event-fixture/session-A"
                    ? order.replaceAll("2026孿生姐妹之夜之鬼迷心竅", "另一個不應選擇的場次")
                    : path === "/"
                      ? loggedOutHome
                      : path.startsWith("/activity/")
                        ? mode === "lottery"
                            ? activity.replaceAll("立即購買", "立即登記")
                            : activity
                        : path.startsWith("/confirm/")
                          ? mode === "lottery"
                              ? lotteryInputPage({ rows: ["filled", "filled"] })
                              : readyInformation + "<p>PRIVATE_INFORMATION_MARKER</p>"
                          : path.startsWith("/checkout/")
                            ? mode === "lottery"
                                ? registerPage
                                : checkout
                            : order,
        });
    });
    await context.addInitScript(installFixtureSessionNavigation);
    await context.addInitScript(
        ({ mode, failure, queue }) => {
            let submitted = 0;
            document.addEventListener("change", () => {
                void (window as any).recordFixture("terms");
            });
            document.addEventListener("click", async event => {
                // 抽選輸入資料頁：條款控制項切換並啟用下一步，下一步轉到確認登記頁
                const lottery = (event.target as Element).closest<HTMLElement>("[data-lottery]");
                if (lottery?.dataset.lottery === "terms") {
                    const input = document.getElementById("terms") as HTMLInputElement;
                    input.checked = !input.checked;
                    document.querySelector<HTMLButtonElement>('[data-lottery="next"]')!.disabled = !input.checked;
                    await (window as any).recordFixture("terms");
                    return;
                }
                if (lottery?.dataset.lottery === "next") {
                    await (window as any).recordFixture("information");
                    location.assign("/checkout/event-fixture/session-B");
                    return;
                }
                if (lottery) {
                    await (window as any).recordFixture("other");
                    return;
                }
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent === "立即購買" || button.textContent === "立即登記") {
                    return; // 場次導頁由共用的 fixture 事件處理。
                } else if (button.querySelector(".mdi-plus")) {
                    const value = button.parentElement!.querySelector("div")!;
                    if (mode === "held-plus") {
                        (window as any).releaseFixturePlus = () => {
                            value.textContent = String(Number(value.textContent) + 1);
                        };
                    } else value.textContent = String(Number(value.textContent) + 1);
                    await (window as any).recordFixture("plus");
                } else if (button.dataset.fixture === "dismiss") {
                    document.querySelector(".v-dialog__content")!.remove();
                    if (mode.startsWith("cycle-")) {
                        document.querySelectorAll(".count-button > div").forEach(value => {
                            value.textContent = "0";
                        });
                    }
                    await (window as any).recordFixture("dismiss");
                } else if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        // 資料頁下一步比照實站轉到付款頁
                        await (window as any).recordFixture("information");
                        location.assign("/checkout/event-fixture/session-B");
                        return;
                    }
                    const tickets = [...document.querySelectorAll(".row.py-1.py-md-4")].map(row => ({
                        name: row.querySelector(".font-weight-medium")!.childNodes[0]!.textContent!.trim(),
                        quantity: Number(row.querySelector(".count-button > div")?.textContent ?? 0),
                    }));
                    await (window as any).recordFixture("submit", tickets);
                    submitted++;
                    if (
                        mode === "failure" ||
                        mode === "cycle-exhausted" ||
                        (mode.startsWith("cycle-") && submitted === 1)
                    ) {
                        document.body.insertAdjacentHTML("beforeend", failure);
                    } else if (mode === "cycle-unknown") {
                        document.body.insertAdjacentHTML("beforeend", '<div role="dialog">未知處理結果</div>');
                    } else if (mode === "queue") {
                        document.body.insertAdjacentHTML("beforeend", queue);
                    } else if (mode !== "close-after-submit") location.assign("/confirm/event-fixture/session-B");
                } else await (window as any).recordFixture("other");
            });
        },
        { mode, failure: failureDialog(), queue: queueDialog },
    );
    return context;
};

// 動態載入正式入口前暫存啟動訊息，避免測試 bootstrap 的 import await 吃掉立即啟動。
const starts: unknown[] = [];
const bufferStart = (input: unknown) => {
    if (
        input &&
        typeof input === "object" &&
        (("activity" in input && "lease" in input && !("type" in input)) ||
            ("type" in input && input.type === "stop-ticketplus"))
    )
        starts.push(input);
};
process.on("message", bufferStart);
// 測試控制頁面生命週期，與正式登入確認及關閉指令分開。
process.on("message", async (input: any) => {
    if (input?.type === "fixture-login") await loginFixture();
    if (input?.type === "fixture-close-page") await context?.pages()[0]?.close();
    if (input?.type === "fixture-crash-page" && context?.pages()[0]) {
        const session = await context.newCDPSession(context.pages()[0]!);
        await session.send("Page.crash").catch(() => {});
    }
    if (input?.type === "fixture-release-queue") {
        await context?.pages()[0]?.goto("https://ticketplus.com.tw/confirm/event-fixture/session-B");
    }
    if (input?.type === "fixture-snapshot") {
        await save();
        process.send?.({ type: "fixture-snapshot", counts, requests });
    }
});
// API 整合測試透過檔案操作測試頁面，不增加正式服務的控制入口。
const control = report + ".control";
watchFile(control, { interval: 20, persistent: false }, async () => {
    const action = await readFile(control, "utf8").catch(() => "");
    if (action === "login") await loginFixture();
    if (action === "stop-worker") process.exit(1);
    if (action === "release-launch") releaseLaunch?.();
    if (action === "release-queue")
        await context?.pages()[0]?.goto("https://ticketplus.com.tw/confirm/event-fixture/session-B");
    if (action === "release-plus") {
        await context?.pages()[0]?.evaluate(() => (window as any).releaseFixturePlus?.());
        await save();
        await writeFile(report + ".released", "yes");
    }
    if (action === "close-page")
        await context
            ?.pages()[0]
            ?.close()
            .catch(() => {});
});
process.once("exit", () => unwatchFile(control));
await import("../../../src/workers/purchaseWorker.js");
process.removeListener("message", bufferStart);
for (const start of starts) process.emit("message", start as never);
process.send?.({ type: "fixture-ready" });
