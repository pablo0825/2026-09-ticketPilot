import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, type Dialog, type Page } from "playwright";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";
import { apiActivity, apiHarness } from "./fixtures/ticketplus/apiHarness.js";
import { eventually, snapshotFeed } from "./fixtures/guiTestHelpers.js";

type Harness = Awaited<ReturnType<typeof apiHarness>>;
const stopLabel = "停止購票";
const loginLabel = "我已登入，開始選票";

async function fixture(mode: string, work: (h: Harness, page: Page, requests: string[]) => Promise<void>) {
    const h = await apiHarness(mode);
    const browser = await chromium.launch();
    const requests: string[] = [];
    try {
        const page = await browser.newPage();
        page.on("request", request => {
            if (request.method() === "POST") requests.push(new URL(request.url()).pathname);
        });
        await work(h, page, requests);
        assert(!requests.includes("/api/purchase"), "停止操作不能另開購票流程");
    } finally {
        await browser.close();
        await h.dispose();
    }
}

async function start(h: Harness) {
    const record = await (await h.request("/api/activities", apiActivity)).json();
    const response = await h.request("/api/purchase", {
        requestId: randomUUID(),
        activityId: record.id,
        expectedActivity: apiActivity,
    });
    assert.equal(response.status, 200);
    return h.until(run =>
        Boolean(run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login")),
    );
}

async function showRun(page: Page, url: string) {
    await page.goto(url);
    await page.getByRole("button", { name: "查看狀態", exact: true }).click();
    await page.locator("#status").waitFor();
}

async function unavailable(page: Page, label: string) {
    const button = page.getByRole("button", { name: label, exact: true });
    assert((await button.count()) === 0 || (await button.isDisabled()));
}

test("TicketPlus 執行狀態分頁：依活動 id 顯示目前這一輪，同名的其他活動不顯示", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page) => {
        // 兩筆同名活動各開一個編輯頁，記下每頁實際載入的活動 id。
        const target = await (await h.request("/api/activities", apiActivity)).json();
        await h.request("/api/activities", apiActivity);
        const pages = [page, await page.context().browser()!.newPage()];
        const opened = new Map<string, Page>();
        for (const [index, current] of pages.entries()) {
            await current.goto(h.url);
            await current.locator("#selectTicketPlus").click();
            const loaded = current.waitForResponse(response =>
                /\/api\/activities\/[^/]+$/.test(new URL(response.url()).pathname),
            );
            await current.getByRole("button", { name: "編輯活動" }).nth(index).click();
            opened.set(new URL((await loaded).url()).pathname.split("/").at(-1)!, current);
            await current.locator(".breadcrumb").waitFor();
        }
        const targetPage = opened.get(target.id)!;
        const otherPage = pages.find(current => current !== targetPage)!;

        // 先停在執行狀態分頁（尚未開始），之後才啟動的一輪也要自動顯示。
        await targetPage.getByRole("button", { name: "執行狀態", exact: true }).click();
        assert.equal(await targetPage.getByRole("heading", { name: "尚未開始" }).count(), 1);

        // 從 API 啟動第一筆活動。
        const response = await h.request("/api/purchase", {
            requestId: randomUUID(),
            activityId: target.id,
            expectedActivity: apiActivity,
        });
        assert.equal(response.status, 200);
        await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );

        // 這筆活動的執行狀態分頁顯示這一輪，停止按鈕也作用在同一輪。
        await targetPage.locator(".lock-chip").waitFor();
        await eventually(async () => assert.equal(await targetPage.locator("#status").innerText(), "請手動登入"));
        assert.equal(await targetPage.getByRole("button", { name: stopLabel, exact: true }).count(), 1);

        // 同名的另一筆活動不顯示這一輪。
        await otherPage.getByRole("button", { name: "執行狀態", exact: true }).click();
        assert.equal(await otherPage.getByRole("heading", { name: "尚未開始" }).count(), 1);
        assert.equal(await otherPage.locator("#status").count(), 0);
        await pages[1]!.close();
    });
});

test("TicketPlus 活動列表：執行中的活動那一列顯示即時狀態與查看狀態", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page) => {
        const run = await start(h);
        assert(run?.activityId);
        await page.goto(h.url);
        await page.locator("#selectTicketPlus").click();

        // 那一列標出來，狀態跟著執行進度顯示，按鈕換成「查看狀態」。
        const row = page.locator("#activities tr", { hasText: apiActivity.eventName });
        await row.locator(".status-badge", { hasText: "等待你" }).waitFor();
        assert.notEqual(await row.evaluate(element => getComputedStyle(element).backgroundColor), "rgba(0, 0, 0, 0)");
        assert.equal(await row.getByRole("button", { name: "編輯活動" }).count(), 0);
        assert(await row.getByRole("button", { name: "刪除", exact: true }).isDisabled());
        assert(await page.locator("#new").isDisabled());

        // 入口已在那一列，上方不再放「查看目前狀態」。
        assert.equal(await page.getByRole("button", { name: "查看目前狀態" }).count(), 0);
        // 「查看狀態」打開這個活動的編輯頁，停在執行狀態分頁，有麵包屑與分頁；欄位鎖住只能看。
        await row.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "請手動登入"));
        assert.equal(await page.locator(".breadcrumb-current").innerText(), apiActivity.eventName);
        assert.equal(
            await page.getByRole("button", { name: "執行狀態", exact: true }).getAttribute("aria-current"),
            "step",
        );
        await page.getByRole("button", { name: "活動與順位", exact: true }).click();
        assert(await page.locator("#eventName").isDisabled());
        await page.getByRole("button", { name: "執行狀態", exact: true }).click();

        // 停止並關閉購票瀏覽器後，那一列回到一般狀態。
        page.once("dialog", dialog => void dialog.accept());
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(current => current?.status === "failed");
        page.once("dialog", dialog => void dialog.accept());
        await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
        await h.until(current => !current?.occupied);

        // 從「查看狀態」打開的這一輪結束後，分頁仍顯示它的結果，不會變成「尚未開始」。
        await eventually(async () => assert.equal(await page.locator(".lock-chip").count(), 0));
        assert.equal(await page.locator("#status").innerText(), "購票已停止");
        await page.locator("#brandHome").click();
        await page.locator("#selectTicketPlus").click();
        await eventually(async () => assert(await row.getByRole("button", { name: "編輯活動" }).isEnabled()));
        assert(!(await row.evaluate(element => element.classList.contains("running-row"))));
        assert.equal(await row.locator(".status-badge").count(), 0);
        assert.equal(await page.getByRole("button", { name: "查看目前狀態" }).count(), 0);
    });
});

test("TicketPlus 活動列表：查看狀態載入活動失敗時改看獨立狀態頁", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page) => {
        await start(h);
        await page.goto(h.url);
        await page.locator("#selectTicketPlus").click();
        const row = page.locator("#activities tr", { hasText: apiActivity.eventName });
        await row.locator(".status-badge").waitFor();

        // 模擬讀取活動失敗：不能停在空白的編輯頁。
        await page.route(/\/api\/activities\/[^/]+$/, route =>
            route.fulfill({ status: 500, json: { error: "讀取失敗" } }),
        );
        await row.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "請手動登入"));
        assert.equal(await page.locator(".breadcrumb").count(), 0);
        assert.match(await page.getByRole("alert").innerText(), /無法開啟活動/);
    });
});

test(
    "平台首頁：查看狀態進入 TicketPlus 活動的執行狀態分頁，沒有活動 id 時看獨立狀態頁",
    { timeout: 30_000 },
    async () => {
        await fixture("success", async (h, page) => {
            // 對應到活動的一輪：進入那個活動的編輯頁，停在執行狀態分頁。
            await start(h);
            await showRun(page, h.url);
            assert.equal(await page.locator(".breadcrumb-current").innerText(), apiActivity.eventName);
            assert.equal(
                await page.getByRole("button", { name: "執行狀態", exact: true }).getAttribute("aria-current"),
                "step",
            );
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "請手動登入"));

            // 沒有活動 id 的一輪（例如舊紀錄）：維持獨立的狀態頁。
            const legacy = waitingRun();
            await snapshotFeed(page, "/api/purchase/events", legacy);
            await page.route("**/api/purchase", route => route.fulfill({ json: legacy }));
            await showRun(page, h.url);
            assert.equal(await page.locator(".breadcrumb").count(), 0);
            assert.equal(await page.locator("#status").innerText(), "請手動登入");
        });
    },
);

test("TicketPlus 停止 GUI：同輪連點只送一次停止，關窗前保留占用", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        await unavailable(page, loginLabel);

        // 購票流程顯示 7 個步驟，開發者紀錄預設收合。
        assert.equal(await page.getByRole("list", { name: "執行步驟" }).getByRole("listitem").count(), 7);
        assert.equal(await page.locator("#logs").isVisible(), false);

        // 連點兩次只會跳出一次確認框；第二次已鎖定，不再詢問。
        let dialogs = 0;
        const acceptStop = (dialog: Dialog) => {
            dialogs++;
            void dialog.accept();
        };
        page.on("dialog", acceptStop);
        await page.getByRole("button", { name: stopLabel, exact: true }).evaluate(element => {
            (element as HTMLButtonElement).click();
            (element as HTMLButtonElement).click();
        });
        page.off("dialog", acceptStop);
        assert.equal(dialogs, 1);
        const finished = await h.until(run => run?.status === "failed");
        assert.equal(finished.occupied, true);
        assert.equal(finished.browserOpen, true);
        assert.equal(finished.canCloseBrowser, true);
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "購票已停止"));
        await unavailable(page, loginLabel);
        await unavailable(page, stopLabel);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 0);
        assert.deepEqual((await h.counts()).counts, {
            session: 0,
            plus: 0,
            submit: 0,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        page.once("dialog", dialog => void dialog.accept());
        await page.getByRole("button", { name: "關閉購票瀏覽器", exact: true }).click();
        await h.until(run => !run?.occupied);
    });
});

test("TicketPlus 停止 GUI：頁面登入後仍可停止，加第一張後解除延遲不再加票或提交", { timeout: 30_000 }, async () => {
    await fixture("held-plus", async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        await h.login();
        await eventually(async () => assert.equal((await h.counts()).counts.plus, 1));
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(run => run?.status === "failed");
        await writeFile(h.report + ".control", "release-plus");
        await eventually(async () => assert.equal(await readFile(h.report + ".released", "utf8"), "yes"));
        assert.deepEqual((await h.counts()).counts, {
            session: 1,
            plus: 1,
            submit: 0,
            dismiss: 0,
            information: 0,
            other: 0,
            terms: 0,
        });
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal(requests.filter(path => path === "/api/purchase/confirm-login").length, 0);
    });
});

test("TicketPlus 停止 GUI：排隊停止保留提交一次並回報結果不明", { timeout: 30_000 }, async () => {
    await fixture("queue", async (h, page, requests) => {
        const run = await start(h);
        await showRun(page, h.url);
        await h.login();
        await eventually(async () => assert.equal((await h.counts()).counts.submit, 1));
        const stopRequest = page.waitForRequest(
            request => new URL(request.url()).pathname === "/api/purchase/stop" && request.method() === "POST",
        );
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        assert.deepEqual((await stopRequest).postDataJSON(), { runId: run.id });
        await h.until(run => run?.status === "unknown");
        await eventually(async () => {
            assert.equal(await page.locator("#status").innerText(), "購票已停止");
            assert.match(await page.locator("#instruction").innerText(), /結果未確認/);
        });
        assert.equal((await h.counts()).counts.submit, 1);
        assert.equal((await h.counts()).counts.information, 0);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        await unavailable(page, stopLabel);
    });
});

test("TicketPlus 停止 GUI：後端接受但回應遺失，重載只恢復狀態不再送停止", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page, requests) => {
        await start(h);
        await page.route("**/api/purchase/stop", async route => {
            const response = await fetch(route.request().url(), {
                method: "POST",
                headers: await route.request().allHeaders(),
                body: route.request().postData(),
                signal: AbortSignal.timeout(5000),
            });
            assert.equal(response.status, 200);
            await response.text();
            await route.abort("failed");
        });
        await showRun(page, h.url);
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(run => run?.status === "failed");
        await showRun(page, h.url);
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        assert.equal(await page.locator("#status").innerText(), "購票已停止");
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        assert.equal((await h.counts()).counts.submit, 0);
    });
});

function waitingRun(): PurchaseSnapshot {
    return {
        id: "fixture-stop",
        requestId: "fixture-stop",
        platform: "ticketplus",
        activityName: "停止測試",
        status: "running",
        browserOpen: true,
        occupied: true,
        canStop: true,
        message: "",
        loginConfirmation: { confirmationId: "fixture-login" },
        events: [
            {
                sequence: 1,
                at: "2026-10-15T00:00:00Z",
                event: { type: "ticketplus", stage: "waiting-for-login" },
            },
        ],
        historyTruncated: false,
    };
}

test("TicketPlus 停止 GUI：傳送未確認仍有舊資格時不重送或登入，新一輪不沿用舊鎖", async () => {
    await fixture("success", async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        await page.route("**/api/purchase/stop", route => route.abort("failed"));
        await showRun(page, h.url);
        page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await eventually(async () => assert.equal(await page.locator("#status").innerText(), "停止要求尚未確認"));
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        await page.locator("#brandHome").click();
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await unavailable(page, stopLabel);
        await unavailable(page, loginLabel);
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
        current = { ...waitingRun(), id: "next-stop", requestId: "next-stop" };
        const receivedNext = page.waitForResponse(
            async response =>
                response.url().includes("/api/purchase/events?") && (await response.text()).includes("next-stop"),
        );
        feed.publish(current);
        await receivedNext;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.locator("#brandHome").click();
        await eventually(async () =>
            assert.equal(await page.getByRole("button", { name: "查看狀態", exact: true }).count(), 1),
        );
        await page.getByRole("button", { name: "查看狀態", exact: true }).click();
        await eventually(async () => {
            const button = page.getByRole("button", { name: stopLabel, exact: true });
            assert.equal(await button.count(), 1);
            assert(await button.isEnabled());
        });
        assert.equal(requests.length, 1);
    });
});

test("TicketPlus 停止 GUI：確認框按取消不送出停止，流程繼續", { timeout: 30_000 }, async () => {
    await fixture("success", async (h, page, requests) => {
        await start(h);
        await showRun(page, h.url);
        const dialog = page.waitForEvent("dialog");
        const click = page.getByRole("button", { name: stopLabel, exact: true }).click();
        const shown = await dialog;
        assert.match(shown.message(), /確定要停止自動操作嗎/);
        await shown.dismiss();
        await click;
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 0);
        assert.equal((await h.snapshot())!.status, "running");
        assert(await page.getByRole("button", { name: stopLabel, exact: true }).isEnabled());

        // 之後仍可正常停止。
        page.once("dialog", next => void next.accept());
        await page.getByRole("button", { name: stopLabel, exact: true }).click();
        await h.until(run => run?.status === "failed");
        assert.equal(requests.filter(path => path === "/api/purchase/stop").length, 1);
    });
});

test("TicketPlus 停止 GUI：Klook、歷史紀錄及缺停止資格均無停止操作", async () => {
    await fixture("success", async (h, page, requests) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        for (const next of [
            { ...waitingRun(), platform: "klook" as const },
            { ...waitingRun(), status: "failed" as const, occupied: false },
            { ...waitingRun(), canStop: undefined },
        ]) {
            current = next;
            feed.publish(current);
            await showRun(page, h.url);
            await unavailable(page, stopLabel);
        }
        assert.equal(requests.length, 0);
    });
});

test("TicketPlus 停止 GUI：停止回應仍是 running 時，晚到不能覆蓋已到資料頁終局", async () => {
    await fixture("success", async (h, page) => {
        let current = waitingRun();
        const feed = await snapshotFeed(page, "/api/purchase/events", current);
        await page.route("**/api/purchase", route => route.fulfill({ json: current }));
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let received = false;
        let completed = false;
        await page.route("**/api/purchase/stop", async route => {
            const stale = { ...waitingRun(), stopRequest: { status: "sent" as const }, canStop: false };
            assert.equal(stale.status, "running");
            received = true;
            await gate;
            await route.fulfill({ json: { status: "sent", run: stale } });
            completed = true;
        });
        try {
            await showRun(page, h.url);
            page.once("dialog", dialog => void dialog.accept()); // 停止前的確認框
            await page.getByRole("button", { name: stopLabel, exact: true }).click();
            await eventually(async () => {
                await page.locator("#status").textContent();
                assert(received);
            });
            current = { ...waitingRun(), status: "payment-ready", canStop: false, stopRequest: { status: "sent" } };
            feed.publish(current);
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "已到付款頁"));
            // 停止重播終局，避免後續快照掩蓋舊回應造成的倒退。
            feed.publish(undefined);
            release();
            await eventually(async () => {
                await page.locator("#status").textContent();
                assert(completed);
            });
            await page.evaluate(
                () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.equal(await page.locator("#status").innerText(), "已到付款頁");
            await unavailable(page, stopLabel);
            await unavailable(page, loginLabel);
        } finally {
            release();
        }
    });
});
