import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

// 使用真正的 worker 與本機 Chromium；攔截所有網站請求，不使用私人 profile。
const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-worker-browser-"));
    const context = await launch(directory, { headless: true });
    await context.route("**/*", route => route.fulfill({ status: 403, body: "fixture denied" }));
    context.once("close", () => { void rm(directory, { recursive: true, force: true }); });
    return context;
};
await import("../../src/local/purchaseWorker.js");
