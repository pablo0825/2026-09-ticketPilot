import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { loadTicketPlusCliSettings, runTicketPlusCli } from "../src/cli/ticketPlus.js";
import { waitForTicketPlusLogin } from "../src/cli/ticketPlusLogin.js";

test("TicketPlus CLI：設定與非互動輸入在開瀏覽器前拒絕，help 不需登入", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-cli-"));
    const path = join(directory, "settings.json");
    const launch = mock.method(chromium, "launchPersistentContext", async () => {
        throw new Error("must not launch");
    });
    const input = new PassThrough();
    const output = new PassThrough();
    try {
        const settings = JSON.parse(await readFile(new URL("../ticketplus.example.json", import.meta.url), "utf8"));
        for (const maxRunMinutes of [undefined, 9]) {
            await writeFile(path, JSON.stringify({ ...settings, maxRunMinutes }));
            await assert.rejects(runTicketPlusCli(["--config", path], { input, output }), /10～1440/);
        }
        await writeFile(path, JSON.stringify({ ...settings, maxRunMinutes: 10 }));
        assert.equal((await loadTicketPlusCliSettings(["--config", path])).platform, "ticketplus");
        for (const args of [[], ["--config"], ["--config", path, "extra"], ["--unknown", path]]) {
            await assert.rejects(loadTicketPlusCliSettings(args), /用法/);
        }
        await assert.rejects(runTicketPlusCli(["--config", path], { input, output }), /互動/);
        assert.equal(await runTicketPlusCli(["--help"], { input, output }), 0);
        await writeFile(path, '{"secret":');
        await assert.rejects(loadTicketPlusCliSettings(["--config", path]), /無法讀取 TicketPlus 設定/);
        await writeFile(path, '{"platform":"klook"}');
        await assert.rejects(loadTicketPlusCliSettings(["--config", path]), /格式錯誤/);
        assert.equal(launch.mock.callCount(), 0);
    } finally {
        launch.mock.restore();
        input.destroy();
        output.destroy();
        await rm(directory, { recursive: true, force: true });
    }
});

test("舊 TicketPlus 人工登入 helper（正式 CLI 已不使用）：只有 Enter 交接，EOF、Ctrl+C、頁面關閉與 crash 取消並清理監聽", async () => {
    for (const action of ["enter", "eof", "interrupt", "close", "crash"]) {
        const input = Object.assign(new PassThrough(), { isTTY: true });
        const output = new PassThrough();
        const page = Object.assign(new EventEmitter(), { isClosed: () => false });
        let settled = false;
        const pending = waitForTicketPlusLogin(page as unknown as Page, { input, output });
        void pending.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        input.write("not-ready\n");
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        if (action === "enter") input.write("\n");
        else if (action === "eof") input.end();
        else if (action === "interrupt") input.write("\u0003");
        else page.emit(action);
        if (action === "enter") await pending;
        else await assert.rejects(pending, /取消|關閉/);
        assert.equal(page.listenerCount("close"), 0);
        assert.equal(page.listenerCount("crash"), 0);
        assert.equal(input.listenerCount("error"), 0);
        input.destroy();
        output.destroy();
    }
});

test("正式 CLI：Enter 不能代替頁面登入，關頁停止且清理監聽", { timeout: 15_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-cli-login-"));
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.newPage();
    const requests: string[] = [];
    await context.route("**/*", route => {
        requests.push(new URL(route.request().url()).pathname);
        return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: '<header class="headerApp"><button>會員登入</button></header>',
        });
    });
    const launch = mock.method(chromium, "launchPersistentContext", async () => context);
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let text = "";
    output.on("data", chunk => {
        text += chunk;
    });
    const listeners = process.listenerCount("SIGINT");
    let running: Promise<number> | undefined;
    try {
        const settings = JSON.parse(await readFile(new URL("../ticketplus.example.json", import.meta.url), "utf8"));
        await writeFile(join(directory, "settings.json"), JSON.stringify({ ...settings, maxRunMinutes: 10 }));
        running = runTicketPlusCli(["--config", join(directory, "settings.json")], { input, output });
        const until = async (check: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!check()) {
                assert(Date.now() < deadline, text);
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        };
        await until(() => /登入/.test(text) && requests.length === 1);
        input.write("\n");
        await new Promise(resolve => setTimeout(resolve, 600));
        assert.deepEqual(requests, ["/"]);
        await context.pages()[0]!.close();
        await until(() => /操作結束後/.test(text));
        assert.deepEqual(requests, ["/"]);
        await context.close();
        assert.equal(await running, 1);
        assert.equal(process.listenerCount("SIGINT"), listeners);
    } finally {
        await context.close();
        await running?.catch(() => {});
        launch.mock.restore();
        await browser.close();
        input.destroy();
        output.destroy();
        await rm(directory, { recursive: true, force: true });
    }
});
