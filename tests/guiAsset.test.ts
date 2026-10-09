import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("GUI 提供編譯後的傳統腳本，保留 token 載入順序與 CSS", async () => {
    // 使用獨立目錄啟動本機服務，不讀取使用者的設定。
    const directory = await mkdtemp(join(tmpdir(), "ticket-gui-asset-"));
    const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
        contactPath: join(directory, "contact.json"),
        runDirectory: join(directory, "runtime"),
    });

    try {
        // 確認 HTML 先提供 token，再載入原本的腳本網址。
        const html = await (await fetch(service.url)).text();
        assert.match(html, /<script>\s*const token = "[a-f0-9]+";\s*<\/script>\s*<script src="\/app.js"><\/script>/);

        // 以傳統 script 解析，避免型別、import 或 export 被送到瀏覽器。
        const response = await fetch(service.url + "/app.js");
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
        assert.equal(response.headers.get("cache-control"), "no-store");

        const script = await response.text();
        const generated = await readFile(new URL("../dist/gui/local/app.js", import.meta.url), "utf8");
        assert.equal(script, generated);
        assert.doesNotThrow(() => new Script(script));

        // 樣式仍由原本的檔案提供。
        const stylesheet = await fetch(service.url + "/style.css");
        assert.match(stylesheet.headers.get("content-type") ?? "", /^text\/css/);
        assert.equal(
            await stylesheet.text(),
            await readFile(new URL("../src/local/style.css", import.meta.url), "utf8"),
        );
    } finally {
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
