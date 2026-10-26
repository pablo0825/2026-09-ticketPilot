import assert from "node:assert/strict";
import { test } from "node:test";
import { withBrowserPage } from "../../fixtures/browserPage.js";
import { applicationActivity, installFixtureSessionNavigation } from "../../fixtures/ticketplus/sessionNavigation.js";

test("應用流程 fixture 的兩個場次各有固定目的地，錯選不會取得目標目的地", async () => {
    await withBrowserPage(async page => {
        const actions: string[] = [];
        await page.exposeFunction("recordFixture", (kind: string) => actions.push(kind));
        await page.addInitScript(installFixtureSessionNavigation);
        await page.route("**/*", route => {
            const path = new URL(route.request().url()).pathname;
            return route.fulfill({
                contentType: "text/html; charset=utf-8",
                body: path.startsWith("/activity/")
                    ? applicationActivity
                    : `<p>${path.endsWith("session-A") ? "其他場次" : "目標場次"}</p>`,
            });
        });
        for (const [index, sessionId, text] of [
            [0, "session-A", "其他場次"],
            [1, "session-B", "目標場次"],
        ] as const) {
            await page.goto("https://ticketplus.com.tw/activity/event-fixture");
            await page.getByRole("button", { name: "立即購買", exact: true }).nth(index).click();
            await page.waitForURL("**/order/event-fixture/" + sessionId, { timeout: 2000 });
            assert.equal(await page.locator("p").innerText(), text);
        }
        assert.deepEqual(actions, ["session", "session"]);
    });
});
