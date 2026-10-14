import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { writeFile, readFile } from "node:fs/promises";
import { appendFileSync, watchFile, unwatchFile } from "node:fs";
import { activity } from "./pages.js";
import { readyOrder, readyInformation, failureDialog, queueDialog } from "./submissionPage.js";

// 只替換瀏覽器環境，正式 worker、runner、DOM 模組與設定解析均照常執行。
let context: BrowserContext | undefined;
const report = process.env.FIXTURE_REPORT!;
appendFileSync(report + ".starts", "started\n");
const mode = process.env.FIXTURE_MODE ?? "success";
const counts = { session: 0, plus: 0, submit: 0, dismiss: 0, information: 0, other: 0, terms: 0 };
const requests: string[] = [];
let flush = Promise.resolve();
function save() {
    const json = JSON.stringify({ counts, requests });
    flush = flush.then(() => writeFile(report, json));
    return flush;
}
chromium.launchPersistentContext = async (_profile, options) => {
    await writeFile(
        report + ".options",
        JSON.stringify({ args: options?.args, channel: options?.channel, profile: _profile }),
    );
    const browser = await chromium.connect(process.env.FIXTURE_BROWSER_ENDPOINT!);
    context = await browser.newContext();
    await context.exposeBinding("recordFixture", async ({ page }, key: keyof typeof counts) => {
        counts[key]++;
        await save();
        if (key === "submit" && mode === "close-after-submit") await page.close();
    });
    await context.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        requests.push(path);
        await save();
        await route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: path.startsWith("/activity/")
                ? activity
                : path.startsWith("/confirm/")
                  ? readyInformation + "<p>PRIVATE_INFORMATION_MARKER</p>"
                  : readyOrder.replace("<div>2</div>", "<div>0</div>"),
        });
    });
    await context.addInitScript(
        ({ mode, failure, queue }) => {
            document.addEventListener("change", () => {
                void (window as any).recordFixture("terms");
            });
            document.addEventListener("click", async event => {
                const button = (event.target as Element).closest("button");
                if (!button) return;
                if (button.textContent === "立即購買") {
                    await (window as any).recordFixture("session");
                    location.assign("/order/event-fixture/session-B");
                } else if (button.querySelector(".mdi-plus")) {
                    const value = button.parentElement!.querySelector("div")!;
                    value.textContent = String(Number(value.textContent) + 1);
                    await (window as any).recordFixture("plus");
                } else if (button.dataset.fixture === "dismiss") {
                    document.querySelector(".v-dialog__content")!.remove();
                    await (window as any).recordFixture("dismiss");
                } else if (button.textContent === "下一步") {
                    if (location.pathname.startsWith("/confirm/")) {
                        await (window as any).recordFixture("information");
                        return;
                    }
                    await (window as any).recordFixture("submit");
                    if (mode === "failure") document.body.insertAdjacentHTML("beforeend", failure);
                    else if (mode === "queue") {
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
    if (input && typeof input === "object" && "activity" in input && "lease" in input && !("type" in input))
        starts.push(input);
};
process.on("message", bufferStart);
// 測試控制頁面生命週期，與正式登入確認及關閉指令分開。
process.on("message", async (input: any) => {
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
    if (action === "stop-worker") process.exit(1);
    if (action === "close-page")
        await context
            ?.pages()[0]
            ?.close()
            .catch(() => {});
});
process.once("exit", () => unwatchFile(control));
await import("../../../src/local/purchaseWorker.js");
process.removeListener("message", bufferStart);
for (const start of starts) process.emit("message", start as never);
process.send?.({ type: "fixture-ready" });
