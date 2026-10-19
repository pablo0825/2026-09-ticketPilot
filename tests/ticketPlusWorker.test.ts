import { chromium } from "playwright";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquirePurchaseLease, purchaseOccupied } from "../src/app/purchaseLock.js";

const settings = {
    platform: "ticketplus",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
};
async function harness(mode = "success", experiment = "0") {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-worker-"));
    const report = join(directory, "report.json");
    // 瀏覽器由測試父程序持有，worker 斷線後仍能確實清理，避免孤兒瀏覽器。
    const browser = await chromium.launchServer({ headless: true }).catch(async error => {
        await rm(directory, { recursive: true, force: true });
        throw error;
    });
    const child = await Promise.resolve()
        .then(() =>
            fork(fileURLToPath(new URL("./fixtures/ticketplus/worker.ts", import.meta.url)), [], {
                execArgv: ["--import", "tsx"],
                stdio: ["ignore", "ignore", "pipe", "ipc"],
                env: {
                    ...process.env,
                    FIXTURE_BROWSER_ENDPOINT: browser.wsEndpoint(),
                    FIXTURE_REPORT: report,
                    FIXTURE_MODE: mode,
                    WEBDRIVER_EXPERIMENT: experiment,
                },
            }),
        )
        .catch(async error => {
            try {
                await browser.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
            throw error;
        });
    const messages: any[] = [];
    let errors = "";
    child.stderr!.on("data", chunk => {
        errors += chunk;
    });
    child.on("message", message => {
        messages.push(message);
    });
    const closed = new Promise<number | null>(resolve => {
        child.once("exit", resolve);
        child.once("error", error => {
            errors += String(error);
            resolve(null);
        });
    });
    async function wait(predicate: (message: any) => boolean): Promise<any> {
        const found = messages.find(predicate);
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null || !child.pid)
            throw new Error(`worker exited: ${errors}`);
        return new Promise((resolve, reject) => {
            const receive = (message: any) => {
                if (predicate(message)) {
                    cleanup();
                    resolve(message);
                }
            };
            const ended = () => {
                cleanup();
                reject(new Error(`worker exited: ${errors}`));
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`worker timeout: ${errors}`));
            }, 12_000);
            function cleanup() {
                clearTimeout(timer);
                child.off("message", receive);
                child.off("exit", ended);
                child.off("error", ended);
            }
            child.on("message", receive);
            child.once("exit", ended);
            child.once("error", ended);
        });
    }
    async function dispose() {
        child.kill();
        try {
            await browser.close();
            await closed;
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
    try {
        await wait(message => message.type === "fixture-ready");
        const lease = acquirePurchaseLease(directory);
        return {
            child,
            messages,
            directory,
            report,
            closed,
            wait,
            start(activity = settings) {
                child.send({ activity, lease });
            },
            async stop() {
                if (child.connected) child.send({ type: "close-browser" });
                await closed;
            },
            dispose,
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}

test("正式 TicketPlus worker：頁面登入後提交一次、資料頁停止並保留占用", { timeout: 30_000 }, async () => {
    const h = await harness("success", "1");
    try {
        // 等正式等待事件後由外部 fixture 更新 DOM，不能以確認 IPC 放行。
        h.child.on("message", (message: any) => {
            if (message.type === "event" && message.event.stage === "waiting-for-login") {
                h.child.send({ type: "fixture-login" });
                h.child.send({ type: "fixture-login" });
            }
        });
        h.child.send({ type: "confirm-ticketplus-login", confirmationId: "early" });
        h.start();
        const result = await h.wait(message => message.type === "result");
        assert.equal(result.outcome, "payment-ready");
        assert.match(result.message, /付款頁/);
        assert.doesNotMatch(JSON.stringify(h.messages), /PRIVATE_INFORMATION_MARKER|information":/);
        assert(purchaseOccupied(h.directory));
        assert(!h.messages.some(message => message.type === "finished"));
        const options = JSON.parse(await readFile(h.report + ".options", "utf8"));
        assert.deepEqual(options.args, ["--disable-blink-features=AutomationControlled"]);
        assert.equal(options.channel, "chrome");
        assert(options.profile.endsWith("browser-profile-ticketplus"));
        await h.stop();
        assert.equal(await h.closed, 0);
        assert(!purchaseOccupied(h.directory));
        const report = JSON.parse(await readFile(h.report, "utf8"));
        assert.deepEqual(report.counts, {
            session: 1,
            plus: 2,
            submit: 1,
            dismiss: 0,
            information: 1,
            other: 0,
            terms: 0,
        });
        assert.deepEqual(report.requests, [
            "/",
            "/activity/event-fixture",
            "/order/event-fixture/session-B",
            "/confirm/event-fixture/session-B",
            "/checkout/event-fixture/session-B",
        ]);
        assert.equal(h.messages.filter(message => message.type === "result").length, 1);
        assert.equal(h.messages.at(-1).type, "finished");
    } finally {
        await h.dispose();
    }
});

test("正式 worker：錯誤確認不啟動、已售完關窗停止；queue 經等待到資料頁", { timeout: 45_000 }, async () => {
    for (const mode of ["failure", "queue"]) {
        const h = await harness(mode);
        try {
            h.start();
            await h.wait(message => message.type === "event" && message.event.stage === "waiting-for-login");
            h.child.send({ type: "confirm-ticketplus-login", confirmationId: "wrong" });
            h.child.send({ type: "wrong-type", confirmationId: "irrelevant" });
            h.child.send({ type: "fixture-snapshot" });
            const snapshot = await h.wait(message => message.type === "fixture-snapshot");
            assert.equal(snapshot.counts.session, 0);
            assert.equal(snapshot.counts.submit, 0);
            h.child.send({ type: "fixture-login" });
            if (mode === "queue") {
                await h.wait(message => message.type === "event" && message.event.stage === "queue");
                assert(!h.messages.some(message => message.type === "result"));
                h.child.send({ type: "fixture-release-queue" });
            }
            const result = await h.wait(message => message.type === "result");
            assert.equal(result.outcome, mode === "failure" ? "failed" : "payment-ready");
            if (mode === "failure") {
                assert.match(result.message, /已售完.*已確認關閉/);
                // 診斷先以紀錄送出，結果訊息不含診斷。
                assert.doesNotMatch(result.message, /提交後停止原因/);
                const diagnosticIndex = h.messages.findIndex(
                    message => message.type === "event" && /提交後停止原因/.test(message.event.message ?? ""),
                );
                assert(diagnosticIndex >= 0 && diagnosticIndex < h.messages.indexOf(result));
            }
            assert.deepEqual(JSON.parse(await readFile(h.report + ".options", "utf8")).args, []);
            await h.stop();
            const report = JSON.parse(await readFile(h.report, "utf8"));
            assert.deepEqual(report.counts, {
                session: 1,
                plus: 2,
                submit: 1,
                dismiss: mode === "failure" ? 1 : 0,
                information: mode === "failure" ? 0 : 1,
                other: 0,
                terms: 0,
            });
            assert.deepEqual(report.requests, [
                "/",
                "/activity/event-fixture",
                "/order/event-fixture/session-B",
                ...(mode === "failure"
                    ? []
                    : ["/confirm/event-fixture/session-B", "/checkout/event-fixture/session-B"]),
            ]);
            assert(!purchaseOccupied(h.directory));
        } finally {
            await h.dispose();
        }
    }
});

test("正式 worker：頁面关闭／crash 取消交接，提交後關頁保留 unknown", { timeout: 45_000 }, async () => {
    for (const mode of ["close-login", "crash-login", "close-after-submit"]) {
        const h = await harness(mode);
        try {
            h.start();
            await h.wait(message => message.type === "event" && message.event.stage === "waiting-for-login");
            if (mode === "close-after-submit") h.child.send({ type: "fixture-login" });
            else h.child.send({ type: mode === "close-login" ? "fixture-close-page" : "fixture-crash-page" });
            const result = await h.wait(message => message.type === "result");
            assert.equal(result.outcome, mode === "close-after-submit" ? "unknown" : "failed");
            h.child.send({ type: "confirm-ticketplus-login", confirmationId: "stale" });
            await h.stop();
            const report = JSON.parse(await readFile(h.report, "utf8"));
            assert.equal(report.counts.session, mode === "close-after-submit" ? 1 : 0);
            assert.equal(report.counts.submit, mode === "close-after-submit" ? 1 : 0);
            assert.equal(report.counts.information, 0);
            assert(!purchaseOccupied(h.directory));
        } finally {
            await h.dispose();
        }
    }
});

test("正式 worker：父服務失聯停止且保留占用；活動名稱不符零點擊", { timeout: 30_000 }, async () => {
    for (const mode of ["disconnect", "mismatch"]) {
        const h = await harness();
        try {
            h.start(mode === "mismatch" ? { ...settings, eventName: "不存在的活動" } : settings);
            await h.wait(message => message.type === "event" && message.event.stage === "waiting-for-login");
            if (mode === "disconnect") {
                h.child.disconnect();
                assert.equal(await h.closed, 1);
                assert(purchaseOccupied(h.directory));
                assert(!h.messages.some(message => message.type === "finished" || message.type === "result"));
            } else {
                h.child.send({ type: "fixture-login" });
                const result = await h.wait(message => message.type === "result");
                assert.equal(result.outcome, "failed");
                assert.match(result.message, /已載入完成，但找不到符合設定名稱的場次.*尚未嘗試點擊場次按鈕/);
                await h.stop();
            }
            const report = JSON.parse(await readFile(h.report, "utf8"));
            assert.equal(report.counts.session, 0);
            assert.equal(report.counts.submit, 0);
        } finally {
            await h.dispose();
        }
    }
});

test("正式 worker：同輪候補結果不被前次售完污染，耗盡更新後明確停止", { timeout: 45_000 }, async () => {
    for (const mode of ["cycle-success", "cycle-unknown", "cycle-exhausted"]) {
        const h = await harness(mode);
        try {
            h.start({ ...settings, targets: [...settings.targets, { ...settings.targets[0]!, ticketType: "學生票" }] });
            await h.wait(message => message.type === "event" && message.event.stage === "waiting-for-login");
            h.child.send({ type: "fixture-login" });
            const result = await h.wait(message => message.type === "result");
            assert.equal(
                result.outcome,
                mode === "cycle-success" ? "payment-ready" : mode === "cycle-unknown" ? "unknown" : "failed",
            );
            if (mode === "cycle-exhausted") {
                assert.match(result.message, /先前 2 次提交已確認售完/);
                assert.match(result.message, /更新完成/);
                assert(h.messages.some(message => message.event?.stage === "waiting-to-refresh"));
                assert(h.messages.some(message => message.event?.stage === "refreshing"));
            }
            if (mode === "cycle-unknown") assert.match(result.message, /結果未確認/);
            assert(purchaseOccupied(h.directory));
            await h.stop();
            const report = JSON.parse(await readFile(h.report, "utf8"));
            assert.equal(report.counts.session, 1);
            assert.equal(report.counts.submit, 2);
            assert.equal(report.counts.dismiss, mode === "cycle-exhausted" ? 2 : 1);
            assert.equal(report.counts.other, mode === "cycle-exhausted" ? 1 : 0);
            assert.equal(report.counts.information, mode === "cycle-success" ? 1 : 0);
            assert.deepEqual(
                report.submissions.map((tickets: any[]) => tickets.filter(ticket => ticket.quantity > 0)),
                [[{ name: "預售票", quantity: 2 }], [{ name: "學生票", quantity: 2 }]],
            );
            assert(!purchaseOccupied(h.directory));
        } finally {
            await h.dispose();
        }
    }
});
