import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { withBrowserPage } from "../fixtures/browserPage.js";

test("共用瀏覽器工具等待工作完成；成功與拋錯後都關閉頁面", async () => {
    let completed: Page | undefined;
    const result = await withBrowserPage(async page => {
        completed = page;
        await page.setContent("<p>ready</p>");
        return page.locator("p").innerText();
    });
    assert.equal(result, "ready");
    assert.equal(completed?.isClosed(), true);

    let failed: Page | undefined;
    const expected = new Error("scenario failed");
    await assert.rejects(
        withBrowserPage(async page => {
            failed = page;
            throw expected;
        }),
        error => error === expected,
    );
    assert.equal(failed?.isClosed(), true);
});
