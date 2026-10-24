import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, directory] = process.argv.slice(2);
const root = fileURLToPath(new URL("../../", import.meta.url));
const serverUrl = new URL("../../src/local/server.ts", import.meta.url);

if (mode === "server-import") {
    let resolutions = 0;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            resolutions++;
            assert.doesNotMatch(specifier, /(?:^|\/)playwright(?:-core)?(?:\/|$)/);
            return nextResolve(specifier, context);
        },
    });
    await import(serverUrl.href);
    assert.ok(resolutions > 0, "解析 hook 必須實際執行");
} else if (mode === "paths") {
    const { projectRoot } = await import("../../src/storage/dataPaths.js");
    const { purchaseLockPath } = await import("../../src/app/purchaseLock.js");
    assert.equal(resolve(projectRoot), resolve(root));
    assert.equal(purchaseLockPath(), join(root, "local-data", "purchase.lock"));
} else if (mode === "default-worker") {
    assert.ok(directory);
    let workerPath: string | undefined;
    const intercepted = new Error("攔截正式 worker，不傳送購票設定");
    // 在載入執行管理前攔截 fork；紀錄和鎖只會寫進測試目錄。
    childProcess.fork = modulePath => {
        workerPath = typeof modulePath === "string" ? modulePath : fileURLToPath(modulePath);
        throw intercepted;
    };
    syncBuiltinESMExports();
    const { PurchaseRuns } = await import("../../src/local/purchaseRuns.js");
    const runs = new PurchaseRuns(directory);
    assert.throws(
        () =>
            runs.start(randomUUID(), {
                platform: "ticketplus",
                eventUrl: "https://ticketplus.com.tw/activity/fixture",
                eventName: "入口測試",
                targets: [{ date: "2027-01-01", time: "20:00", ticketType: "A", quantity: 1 }],
                maxRunMinutes: 10,
            }),
        error => error === intercepted,
    );
    assert.ok(workerPath, "必須驗證 PurchaseRuns 實際傳給 fork 的預設入口");
    await access(workerPath);
    // 只載入入口，不傳送 activity，確認動態依賴完整且不啟動瀏覽器。
    const loaded = childProcess.spawnSync(
        process.execPath,
        [
            "--import",
            pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href,
            "--input-type=module",
            "-e",
            `import assert from "node:assert/strict"; await import(${JSON.stringify(pathToFileURL(workerPath).href)}); assert.ok(process.listenerCount("message") > 0); assert.ok(process.listenerCount("disconnect") > 0); console.log("worker-loaded");`,
        ],
        { cwd: directory, encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /worker-loaded/);
} else if (mode === "main") {
    // 替換服務模組，避免正式入口讀寫使用者紀錄或開啟網路服務。
    registerHooks({
        load(url, context, nextLoad) {
            if (url === serverUrl.href) {
                return {
                    format: "module",
                    shortCircuit: true,
                    source: `export async function startLocalServer() {
                        console.log("isolated-service-started");
                        return { url: "http://127.0.0.1:0", async close() { console.log("isolated-service-closed"); } };
                    }`,
                };
            }
            return nextLoad(url, context);
        },
    });
    childProcess.spawn = () => {
        throw new Error("--no-open 不應開啟瀏覽器");
    };
    syncBuiltinESMExports();
    process.argv.push("--no-open");
    await import("../../src/local/main.js");
    process.emit("SIGTERM");
} else {
    throw new Error(`未知測試模式：${mode}`);
}
