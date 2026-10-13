import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("正式 GUI 提供 React 打包模組與 CSS，不再提供舊腳本", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-gui-asset-"));
    const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
        contactPath: join(directory, "contact.json"),
        runDirectory: join(directory, "runtime"),
    });
    try {
        const response = await fetch(service.url);
        const html = await response.text();
        const token = /<meta name="local-token" content="([a-f0-9]+)"/.exec(html)![1]!;
        assert.match(html, /<script type="module" crossorigin src="\/assets\/[^"\s]+\.js"><\/script>/);
        assert.doesNotMatch(response.headers.get("content-security-policy")!, /script-src[^;]*unsafe-inline/);
        assert.doesNotMatch(html, /__TOKEN__|\/app.js/);

        // 比對實際提供的產物與打包檔案，而非只檢查副檔名。
        const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(match => match[1]!);
        assert.equal(paths.length, 2);
        for (const path of paths) {
            const asset = await fetch(service.url + path);
            assert.equal(asset.status, 200);
            assert.match(asset.headers.get("content-type")!, path.endsWith(".js") ? /^text\/javascript/ : /^text\/css/);
            assert.equal(asset.headers.get("cache-control"), "no-store");
            assert.equal(await asset.text(), await readFile(new URL("../dist/react" + path, import.meta.url), "utf8"));
        }
        assert.equal((await fetch(service.url + "/app.js", { headers: { "X-Local-Token": token } })).status, 404);
    } finally {
        await service.close();
        await rm(directory, { recursive: true, force: true });
    }
});
