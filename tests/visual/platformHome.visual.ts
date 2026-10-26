import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { ActivityStore } from "../../src/storage/activityStore.js";
import { startLocalServer } from "../../src/server/server.js";

const baselineUrl = new URL("./baselines/platformHome.png", import.meta.url);
const environmentUrl = new URL("./baselines/platformHome.json", import.meta.url);
const output = new URL("../../test-results/visual/", import.meta.url);

function difference(expected: Buffer, actual: Buffer) {
    const left = PNG.sync.read(expected);
    const right = PNG.sync.read(actual);
    assert.equal(right.width, left.width, "截圖寬度改變");
    assert.equal(right.height, left.height, "截圖高度改變");
    const diff = new PNG({ width: left.width, height: left.height });
    const pixels = pixelmatch(left.data, right.data, diff.data, left.width, left.height, { threshold: 0.1 });
    return { pixels, png: PNG.sync.write(diff) };
}

test("平台首頁視覺試點：固定環境符合基準，刻意破壞版面能被發現", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticket-visual-"));
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let server: Awaited<ReturnType<typeof startLocalServer>> | undefined;
    try {
        server = await startLocalServer(new ActivityStore(join(directory, "events")), {
            runDirectory: join(directory, "runtime"),
        });
        browser = await chromium.launch();
        const environment = {
            platform: process.platform,
            arch: process.arch,
            osRelease: release(),
            browser: browser.version(),
            viewport: { width: 1280, height: 720 },
            deviceScaleFactor: 1,
            locale: "zh-TW",
            colorScheme: "light",
        };
        const update = process.env.UPDATE_VISUAL_BASELINE === "1";
        if (!update) {
            assert.deepEqual(
                environment,
                JSON.parse(await readFile(environmentUrl, "utf8")),
                "截圖環境不同；請在記錄的基準環境執行，不要直接覆寫基準。",
            );
        }
        const page = await browser.newPage({
            viewport: environment.viewport,
            deviceScaleFactor: 1,
            locale: "zh-TW",
            colorScheme: "light",
            reducedMotion: "reduce",
        });
        await page.goto(server.url);
        await page.getByRole("button", { name: "進入 TicketPlus", exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        const actual = await page.screenshot({ animations: "disabled" });
        await mkdir(output, { recursive: true });
        await writeFile(new URL("actual.png", output), actual);
        if (update) {
            await writeFile(baselineUrl, actual);
            await writeFile(environmentUrl, JSON.stringify(environment, null, 2) + "\n");
        }
        const expected = await readFile(baselineUrl);
        const result = difference(expected, actual);
        await writeFile(new URL("diff.png", output), result.png);
        assert.equal(result.pixels, 0, "首頁與基準不同，請查看 test-results/visual/diff.png");

        // 真的改變畫面，確認比較流程不會把所有圖片都當成通過。
        await page.addStyleTag({ content: "body { background: #ff0000 !important; }" });
        const broken = await page.screenshot({ animations: "disabled" });
        const mutation = difference(expected, broken);
        assert(mutation.pixels > 1000, "刻意破壞背景後，圖片比較應發現明顯差異");
        await writeFile(new URL("mutation-diff.png", output), mutation.png);
    } finally {
        try {
            await browser?.close();
        } finally {
            try {
                await server?.close();
            } finally {
                await rm(directory, { recursive: true, force: true });
            }
        }
    }
});
