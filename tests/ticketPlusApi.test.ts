import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { apiHarness, apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";

// 本 commit 只接啟動；正式 API 仍沒有登入確認入口。
test(
    "TicketPlus API：無聯絡資料／損壞聯絡檔均能啟動，重送僅一個worker，停在登入交接",
    { timeout: 40_000 },
    async () => {
        for (const corrupt of [false, true]) {
            const h = await apiHarness();
            try {
                if (corrupt) await writeFile(h.contactPath, "{broken");
                const created = await (await h.request("/api/activities", apiActivity)).json();
                const input = { requestId: randomUUID(), activityId: created.id, expectedActivity: apiActivity };
                const responses = await Promise.all([
                    h.request("/api/purchase", input),
                    h.request("/api/purchase", input),
                ]);
                assert(responses.every(response => response.status === 200));
                const [first, second] = await Promise.all(responses.map(response => response.json()));
                assert.equal(first.id, second.id);
                const run = await h.until(run =>
                    Boolean(
                        run?.events.some(
                            item => item.event.type === "ticketplus" && item.event.stage === "login-ready",
                        ),
                    ),
                );
                assert.equal(run.platform, "ticketplus");
                assert.equal(run.status, "running");
                assert.equal(run.browserOpen, true);
                assert(purchaseOccupied(h.runtime));
                assert.equal(run.canCloseBrowser, false);
                assert.equal((await h.request("/api/purchase", { ...input, requestId: randomUUID() })).status, 400);
                assert.equal(
                    (
                        await h.request("/api/purchase", {
                            ...input,
                            expectedActivity: { ...apiActivity, target: { ...apiActivity.target, quantity: 3 } },
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (await h.request("/api/purchase/confirm-login", { runId: run.id, confirmationId: randomUUID() }))
                        .status,
                    404,
                );
                assert.equal((await h.request("/api/purchase", input)).status, 200);
                assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
                const report = await h.counts();
                assert.deepEqual(report.requests, ["/activity/event-fixture"]);
                assert.deepEqual(report.counts, {
                    session: 0,
                    plus: 0,
                    submit: 0,
                    dismiss: 0,
                    information: 0,
                    other: 0,
                    terms: 0,
                });
                const persisted = JSON.parse(
                    await readFile(join(h.runtime, "runs", input.requestId + ".json"), "utf8"),
                );
                assert.equal(persisted.snapshot.platform, "ticketplus");
                // 人工關閉購票頁以取消等待，再用既有 API 關閉剩餘瀏覽器。
                await h.closePage();
                await h.until(run => run?.status === "failed");
                assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
                await h.until(run => !run?.occupied);
                assert(!purchaseOccupied(h.runtime));
            } finally {
                await h.dispose();
            }
        }
    },
);

test("TicketPlus API：設定不符、誤傳contact與Klook缺資料皆在啟動前拒絕，simulation仍拒絕", async () => {
    const h = await apiHarness();
    try {
        const tp = await (await h.request("/api/activities", apiActivity)).json();
        const base = { requestId: randomUUID(), activityId: tp.id, expectedActivity: apiActivity };
        for (const input of [
            { ...base, expectedContact: null },
            { ...base, expectedContact: {} },
            { ...base, expectedActivity: { ...apiActivity, eventName: "其他活動" } },
        ]) {
            const response = await h.request("/api/purchase", input);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).notAccepted, true);
        }
        const simulation = await h.request("/api/simulation", { requestId: randomUUID(), activityId: tp.id });
        assert.equal(simulation.status, 400);
        assert.match((await simulation.json()).error, /尚未實作/);
        const klook = {
            platform: "klook",
            eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
            eventName: "Klook",
            fallbackMode: "STRICT",
            excludeKeywords: [],
            targets: [{ date: "2026-10-30", time: "20:00", area: "A區", quantity: 1, adjacent: false }],
        };
        const kl = await (await h.request("/api/activities", klook)).json();
        assert.equal(
            (await h.request("/api/purchase", { requestId: randomUUID(), activityId: kl.id, expectedActivity: klook }))
                .status,
            400,
        );
        assert.equal(await h.snapshot(), null);
        assert(!purchaseOccupied(h.runtime));
        assert.deepEqual(await readdir(join(h.runtime, "runs")), []);
        await assert.rejects(readFile(h.report + ".starts"), { code: "ENOENT" });
    } finally {
        await h.dispose();
    }
});
