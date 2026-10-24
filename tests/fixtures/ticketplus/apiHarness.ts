import { chromium } from "playwright";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLocalServer } from "../../../src/local/server.js";
import { ActivityStore } from "../../../src/config/activityStore.js";
import type { PurchaseSnapshot } from "../../../src/local/purchaseRuns.js";

export const apiActivity = {
    platform: "ticketplus",
    maxRunMinutes: 10,
    eventUrl: "https://ticketplus.com.tw/activity/event-fixture",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
};
export async function apiHarness(mode = "success") {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-api-flow-"));
    const report = join(directory, "report.json");
    const runtime = join(directory, "runtime");
    const contactPath = join(directory, "contact.json");
    const keys = ["FIXTURE_REPORT", "FIXTURE_MODE", "FIXTURE_BROWSER_ENDPOINT"];
    const previous = keys.map(key => process.env[key]);
    let browser: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
    let service: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    async function dispose() {
        // 即使驗證途中拋錯，也終止測試 worker，等主服務收完退出事件再關閉。
        try {
            if (service) await writeFile(report + ".control", "stop-worker");
            await browser?.close();
            if (service) {
                for (let attempt = 0; ; attempt++) {
                    try {
                        await service.close();
                        break;
                    } catch (error) {
                        if (attempt >= 100) throw error;
                        await new Promise(resolve => setTimeout(resolve, 20));
                    }
                }
            }
        } finally {
            keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
            });
            await rm(directory, { recursive: true, force: true });
        }
    }
    try {
        browser = await chromium.launchServer({ headless: true });
        process.env.FIXTURE_BROWSER_ENDPOINT = browser.wsEndpoint();
        process.env.FIXTURE_REPORT = report;
        process.env.FIXTURE_MODE = mode;
        service = await startLocalServer(new ActivityStore(join(directory, "events")), {
            contactPath,
            runDirectory: runtime,
            purchaseWorker: new URL("./worker.ts", import.meta.url),
        });
        const url = service.url;
        const html = await (await fetch(url)).text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        const headers = { "X-Local-Token": token, "Content-Type": "application/json" };
        async function request(path: string, body?: unknown) {
            return fetch(url + path, {
                method: body === undefined ? "GET" : "POST",
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        }
        async function snapshot(): Promise<PurchaseSnapshot | null> {
            return (await request("/api/purchase")).json();
        }
        async function until(
            check: (run: PurchaseSnapshot | null) => boolean,
            timeoutMs = 12_000,
        ): Promise<PurchaseSnapshot> {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const run = await snapshot();
                if (check(run)) return run!;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error("API snapshot timeout: " + JSON.stringify(await snapshot()));
        }
        return {
            directory,
            runtime,
            contactPath,
            report,
            url,
            headers,
            token,
            request,
            snapshot,
            until,
            dispose,
            counts: async () => JSON.parse(await readFile(report, "utf8")),
            login: async () => writeFile(report + ".control", "login"),
            closePage: async () => writeFile(report + ".control", "close-page"),
        };
    } catch (error) {
        await dispose();
        throw error;
    }
}
