import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// 子程序攔截設定讀取與瀏覽器啟動，驗證真實 main 的先後順序。
// 不讀取使用者 contact.local.json，也不啟動瀏覽器或連線網站。
const valid = { firstName: "Fixture", lastName: "Test", regionLabel: "台灣 (+886)", phone: "0912345678", email: "fixture@example.com" };

function startWithContact(source: string | null, code = "ENOENT", pause = "") {
    const script = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        import { chromium } from "playwright";
        // 模擬互動終端機，讓 contact 暫停模式進入設定檢查而非 TTY 檢查。
        Object.defineProperty(process.stdin, "isTTY", { value: true });
        Object.defineProperty(process.stdout, "isTTY", { value: true });
        const originalRead = fs.readFile;
        fs.readFile = async (path, ...args) => {
            if (String(path).endsWith("/contact.local.json")) {
                const source = ${JSON.stringify(source)};
                if (source === null) throw Object.assign(new Error("private-file-detail"), { code: ${JSON.stringify(code)} });
                return source;
            }
            return originalRead(path, ...args);
        };
        syncBuiltinESMExports();
        chromium.launchPersistentContext = async () => { throw new Error("FIXTURE_BROWSER_BOUNDARY"); };
        await import("./src/main.ts");
    `;
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, FLOW_PAUSE: pause },
        encoding: "utf8",
        timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const output = result.stdout + result.stderr;
    assert.doesNotMatch(output, /private-file-detail|fixture@example.com|0912345678/);
    return output;
}

test("缺少個資：啟動前提示補齊，包含 contact 暫停模式，不開瀏覽器", () => {
    for (const pause of ["", "contact"]) {
        const output = startWithContact(null, "ENOENT", pause);
        assert.match(output, /缺少 contact.local.json.*contact.example.json/);
        assert.doesNotMatch(output, /FIXTURE_BROWSER_BOUNDARY|停在個人資料頁/);
    }
});

test("無效 JSON、缺欄位、格式錯誤與讀取失敗均不開瀏覽器", () => {
    const cases: [string | null, string, RegExp][] = [
        ["{bad", "ENOENT", /不是有效的 JSON/],
        [JSON.stringify({ ...valid, firstName: undefined }), "ENOENT", /請填寫名字/],
        [JSON.stringify({ ...valid, email: "invalid" }), "ENOENT", /電子信箱格式不完整/],
        [null, "EACCES", /無法讀取 contact.local.json/],
    ];
    for (const [source, code, message] of cases) {
        const output = startWithContact(source, code);
        assert.match(output, message);
        assert.doesNotMatch(output, /FIXTURE_BROWSER_BOUNDARY/);
    }
});

test("完整個資才會到達瀏覽器啟動邊界", () => {
    assert.match(startWithContact(JSON.stringify(valid)), /FIXTURE_BROWSER_BOUNDARY/);
});
