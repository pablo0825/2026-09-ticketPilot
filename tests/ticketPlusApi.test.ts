import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { apiHarness, apiActivity } from "./fixtures/ticketplus/apiHarness.js";
import { purchaseOccupied } from "../src/app/purchaseLock.js";

// 不確認登入的啟動案例，必須停住等待人工交接。
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
                            item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login",
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
                            expectedActivity: {
                                ...apiActivity,
                                targets: [{ ...apiActivity.targets[0]!, quantity: 3 }],
                            },
                        })
                    ).status,
                    400,
                );
                assert.equal(
                    (await h.request("/api/purchase/confirm-login", { runId: run.id, confirmationId: randomUUID() }))
                        .status,
                    400,
                );
                assert.equal((await h.request("/api/purchase", input)).status, 200);
                assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
                const report = await h.counts();
                assert.deepEqual(report.requests, ["/"]);
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
                assert.equal(persisted.fingerprintVersion, 5);
                const { targets, ...identity } = apiActivity;
                const target = targets[0]!;
                const canonicalRetry = await h.request("/api/purchase", {
                    ...input,
                    expectedActivity: { ...identity, targets: [target] },
                });
                assert.equal(canonicalRetry.status, 200);
                assert.equal((await canonicalRetry.json()).id, run.id);
                assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
                // 人工關閉購票頁以取消等待，再用既有 API 關閉剩餘瀏覽器。
                await h.closePage();
                await h.until(run => run?.status === "failed");
                assert.equal((await h.request("/api/purchase/close-browser", { runId: run.id })).status, 200);
                await h.until(run => !run?.occupied);
                assert(!purchaseOccupied(h.runtime));
                const list = await (await h.request("/api/activities")).json();
                assert.equal(
                    list.activities.find((item: { id: string }) => item.id === created.id).executionStatus,
                    "已執行",
                );
                // 明寫購票不算設定變更，改成抽選才算
                const status = async (body: object) => {
                    const response = await fetch(h.url + "/api/activities/" + created.id, {
                        method: "PUT",
                        headers: h.headers,
                        body: JSON.stringify(body),
                    });
                    assert.equal(response.status, 200);
                    const listed = await (await h.request("/api/activities")).json();
                    return listed.activities.find((item: { id: string }) => item.id === created.id).executionStatus;
                };
                assert.equal(await status({ ...identity, targets: [target], flowType: "purchase" }), "已執行");
                assert.equal(await status({ ...identity, targets: [target], flowType: "lottery" }), "設定已更新");
                const update = await fetch(h.url + "/api/activities/" + created.id, {
                    method: "PUT",
                    headers: h.headers,
                    body: JSON.stringify({ ...identity, targets: [{ ...target, quantity: 3 }] }),
                });
                assert.equal(update.status, 200);
                const changedList = await (await h.request("/api/activities")).json();
                assert.equal(
                    changedList.activities.find((item: { id: string }) => item.id === created.id).executionStatus,
                    "設定已更新",
                );
            } finally {
                await h.dispose();
            }
        }
    },
);

test("TicketPlus API：設定不符、誤傳contact與Klook缺資料皆在啟動前拒絕", async () => {
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

test("TicketPlus API：同場次第一順位售完，第二順位提交一次並到資料頁", { timeout: 20_000 }, async () => {
    const h = await apiHarness();
    try {
        const activity = {
            ...apiActivity,
            targets: [
                { date: "2026-10-30", time: "20:00", ticketType: "身障票", quantity: 1 },
                { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
            ],
        };
        const saved = await (await h.request("/api/activities", activity)).json();
        const input = { requestId: randomUUID(), activityId: saved.id, expectedActivity: activity };
        assert.equal((await h.request("/api/purchase", input)).status, 200);
        const waiting = await h.until(run =>
            Boolean(
                run?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
            ),
        );
        await h.login();
        await h.until(run => run?.status === "payment-ready");
        const report = await h.counts();
        assert.deepEqual(report.submissions, [
            [
                { name: "學生票", quantity: 0 },
                { name: "預售票", quantity: 2 },
                { name: "身障票", quantity: 0 },
            ],
        ]);
        assert.deepEqual(report.counts, {
            session: 1,
            plus: 2,
            submit: 1,
            dismiss: 0,
            information: 1,
            other: 0,
            terms: 0,
        });
        assert.deepEqual(report.requests, [
            "/",
            "/activity/event-fixture",
            "/order/event-fixture/session-B",
            "/confirm/event-fixture/session-B",
            "/checkout/event-fixture/session-B",
        ]);
        assert.equal((await h.request("/api/purchase", input)).status, 200);
        assert.equal(await readFile(h.report + ".starts", "utf8"), "started\n");
        assert.equal((await h.request("/api/purchase/close-browser", { runId: waiting.id })).status, 200);
        await h.until(run => !run?.occupied);
    } finally {
        await h.dispose();
    }
});
