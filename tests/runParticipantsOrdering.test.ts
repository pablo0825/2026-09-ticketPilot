import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";
import type { PurchaseSnapshot } from "../src/local/purchaseRuns.js";
import { snapshotFeed, eventually } from "./fixtures/guiTestHelpers.js";

for (const newerSnapshot of [false, true]) {
    test(`參加者確認回應：${newerSnapshot ? "晚到不能覆蓋即時終局" : "沒有新快照時接受回應"}`, async () => {
        // 使用本機服務與攔截回應，不連線購票網站。
        const directory = await mkdtemp(join(tmpdir(), "participants-ordering-"));
        const service = await startLocalServer(new ActivityStore(join(directory, "events")), {
            runDirectory: join(directory, "runtime"),
        });
        const browser = await chromium.launch();
        let release = () => {};
        try {
            const page = await browser.newPage();
            const confirmationId = "01234567-89ab-4cde-8fab-0123456789ab";
            const waiting: PurchaseSnapshot = {
                id: "participants-fixture",
                requestId: "request-fixture",
                activityName: "抽選測試",
                platform: "ticketplus",
                status: "running",
                browserOpen: true,
                occupied: true,
                message: "",
                historyTruncated: false,
                participantConfirmation: { confirmationId },
                events: [
                    {
                        sequence: 1,
                        at: "2026-10-19T00:00:00Z",
                        event: {
                            type: "ticketplus",
                            stage: "waiting-for-participants",
                            confirmationId,
                        },
                    },
                ],
            };
            const finished: PurchaseSnapshot = {
                ...waiting,
                status: "registration-ready",
                participantConfirmation: undefined,
            };
            const feed = await snapshotFeed(page, "/api/purchase/events", waiting);
            await page.route("**/api/purchase", route => route.fulfill({ json: waiting }));
            const gate = new Promise<void>(resolve => {
                release = resolve;
            });
            let requests = 0;
            await page.route("**/api/purchase/confirm-participants", async route => {
                requests++;
                assert.deepEqual(route.request().postDataJSON(), { runId: waiting.id, confirmationId });
                await gate;
                await route.fulfill({
                    json: { run: newerSnapshot ? { ...waiting, participantConfirmation: undefined } : finished },
                });
            });

            // 先顯示等待狀態，再暫停快照與確認回應。
            await page.goto(service.url);
            await page.getByRole("button", { name: "查看目前狀態", exact: true }).click();
            await eventually(async () => assert.equal(await page.locator("#status").innerText(), "請填寫參加者"));
            feed.publish(undefined);
            const response = page.waitForResponse("**/api/purchase/confirm-participants");
            await page.getByRole("button", { name: "參加者已填完", exact: true }).click();
            await eventually(async () => assert.equal(requests, 1));

            // 先送達終局，之後停止重播，避免掩蓋舊回應造成的倒退。
            if (newerSnapshot) {
                feed.publish(finished);
                await eventually(async () =>
                    assert.equal(await page.locator("#status").innerText(), "已停在確認登記前"),
                );
                feed.publish(undefined);
            }
            release();
            await (await response).finished();
            await eventually(async () =>
                assert.equal(await page.getByRole("button", { name: "參加者已填完", exact: true }).count(), 0),
            );
            await page.evaluate(
                () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))),
            );
            assert.equal(await page.locator("#status").innerText(), "已停在確認登記前");
            assert.equal(requests, 1);
        } finally {
            release();
            await browser.close();
            await service.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}
