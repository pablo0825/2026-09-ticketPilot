import { parseTicketPlusActivity } from "../../../src/config/platforms/ticketplus/activitySettings.js";
import { apiActivity } from "../../fixtures/ticketplus/apiHarness.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { acquirePurchaseLease, purchaseOccupied } from "../../../src/storage/purchaseLock.js";
import { PurchaseRuns } from "../../../src/server/runs/purchaseRuns.js";
import { ActivityStore } from "../../../src/storage/activityStore.js";
import { runTicketPlus } from "../../../src/app/flows/ticketplus/runTicketPlus.js";
const worker = new URL("../../fixtures/guiPurchaseWorker.ts", import.meta.url);
const activity = { ...apiActivity, eventName: "Fixture" };
async function until(check: () => boolean) {
    for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 30));
    assert(check());
}

test("實際 runner 的占用必須等流程與瀏覽器都結束，兩種先後順序皆正確", async () => {
    for (const closeFirst of [false, true]) {
        const dir = await mkdtemp(join(tmpdir(), "ticket-lease-"));
        const lease = acquirePurchaseLease(dir);
        const context = new EventEmitter();
        let releaseNavigation: () => void = () => {};
        const pending = new Promise<void>(resolve => (releaseNavigation = resolve));
        const page = {
            evaluate: async () => false,
            goto: async () => {
                await pending;
                return { ok: () => false, status: () => 403 };
            },
        };
        Object.assign(context, { pages: () => [page] });
        const launch = mock.method(chromium, "launchPersistentContext", async () => context as never);
        try {
            let opened = false;
            const result = runTicketPlus(parseTicketPlusActivity(activity), {
                lease,
                onBrowser: () => {
                    opened = true;
                },
            });
            const settled = result.then(value => assert.equal(value.outcome, "stopped"));
            await until(() => opened);
            assert.throws(() => acquirePurchaseLease(dir), /占用/);
            if (closeFirst) {
                context.emit("close");
                assert(purchaseOccupied(dir));
            }
            releaseNavigation();
            await settled;
            if (!closeFirst) {
                assert(purchaseOccupied(dir));
                context.emit("close");
            }
            assert(!purchaseOccupied(dir));
        } finally {
            launch.mock.restore();
            await rm(dir, { recursive: true, force: true });
        }
    }
});

test("付款結果不等於可重啟；相同請求與服務重開不重複執行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-runs-"));
    const runs = new PurchaseRuns(dir, worker);
    const id = randomUUID();
    try {
        const first = runs.start(id, activity);
        assert.equal(runs.start(id, activity).id, first.id);

        // 同一請求換張數重送，必須拒絕，不能當成原結果。
        const changedQuantity = { ...activity, targets: [{ ...activity.targets[0]!, quantity: 3 }] };
        assert.throws(() => runs.start(id, changedQuantity), /更換設定/);
        await until(() => runs.snapshot()?.status === "payment-ready");
        assert(runs.busy());
        assert.throws(() => runs.start(randomUUID(), activity), /占用/);
        assert.throws(() => runs.close(), /尚未結束/);
        await until(() => !runs.busy());
        assert.equal(runs.snapshot()?.status, "payment-ready");
        runs.close();
        const restarted = new PurchaseRuns(dir, worker);
        assert.equal(restarted.start(id, activity).id, first.id);
        assert(!restarted.busy());
        restarted.close();
    } finally {
        await until(() => !runs.busy());
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("程序異常保留占用、重啟不續購；錯設定不拿占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-crash-"));
    const runs = new PurchaseRuns(dir, worker);
    try {
        assert.throws(() => runs.start(randomUUID(), {}));
        assert(!purchaseOccupied(dir));
        const id = randomUUID();
        const data = { ...activity, eventName: "CRASH" };
        const record = await new ActivityStore(join(dir, "events")).save(data);
        const started = runs.start(id, data, record.id);
        await until(() => runs.snapshot()?.status === "interrupted");
        assert.equal(runs.snapshot()?.id, started.id);
        assert.equal(runs.snapshot()?.platform, "ticketplus");
        assert.equal(runs.snapshot()?.activityName, "CRASH");
        assert.match(runs.snapshot()!.message, /異常/);
        assert.equal(runs.activityStatus(record), "已執行");
        assert(purchaseOccupied(dir));
        runs.close();
        const next = new PurchaseRuns(dir, worker);
        assert.equal(next.snapshot()?.id, started.id);
        assert.equal(next.snapshot()?.platform, "ticketplus");
        assert.equal(next.start(id, data, record.id).status, "interrupted");
        assert.equal(next.activityStatus(record), "已執行");
        assert.throws(() => next.start(randomUUID(), activity), /占用/);
        next.close();
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("關閉只接受目前已結束的自有瀏覽器，重複請求不重啟", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-close-"));
    const runs = new PurchaseRuns(dir, worker);
    const outcomes = {
        HOLD_PAYMENT: "payment-ready",
        HOLD_FAILED: "failed",
        HOLD_UNKNOWN: "unknown",
        HOLD_ERROR: "payment-ready",
    } as const;
    try {
        for (const name of ["HOLD_PAYMENT", "HOLD_FAILED", "HOLD_UNKNOWN", "HOLD_ERROR"] as const) {
            const requestId = randomUUID();
            const data = { ...activity, eventName: name };
            const first = runs.start(requestId, data);
            await assert.rejects(runs.closeBrowser(first.id), /仍在執行/);
            await until(() => runs.snapshot()?.canCloseBrowser === true);
            assert.equal(runs.start(requestId, data).canCloseBrowser, true);
            await assert.rejects(runs.closeBrowser("old-run"), /已變更/);
            const restored = new PurchaseRuns(dir, worker);
            assert.equal(restored.snapshot()?.canCloseBrowser, false);

            // 子程序回報的結果、事件與瀏覽器狀態都已寫入檔案，服務重開後仍讀得到。
            assert.equal(restored.snapshot()?.id, first.id);
            assert.equal(restored.snapshot()?.status, outcomes[name]);
            assert.equal(restored.snapshot()?.events.length, 2);
            assert.equal(restored.snapshot()?.browserOpen, true);
            await assert.rejects(restored.closeBrowser(first.id), /無法控制/);
            restored.close();
            const status = runs.snapshot()!.status;
            if (name === "HOLD_ERROR") {
                await assert.rejects(runs.closeBrowser(first.id), /關閉失敗/);
                assert(runs.busy());
                await until(() => !runs.busy());
            } else {
                const results = await Promise.all([runs.closeBrowser(first.id), runs.closeBrowser(first.id)]);
                for (const result of results) {
                    assert.equal(result.status, status);
                    assert.equal(result.browserOpen, false);
                    assert.equal(result.occupied, false);
                }
                assert.equal((await runs.closeBrowser(first.id)).id, first.id);
            }
        }
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("正式 worker：失敗後收到關閉指令，實際關閉本機瀏覽器並解除占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-worker-close-"));
    const runs = new PurchaseRuns(dir, new URL("../../fixtures/closeBrowserWorker.ts", import.meta.url));
    try {
        const first = runs.start(randomUUID(), activity);
        await until(() => runs.snapshot()?.canCloseBrowser === true);
        assert.equal(runs.snapshot()?.status, "failed");
        const result = await runs.closeBrowser(first.id);
        assert.equal(result.browserOpen, false);
        assert.equal(result.occupied, false);
        assert.equal(result.status, "failed");
        assert(!purchaseOccupied(dir));
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("活動狀態：同名分離、實際內容比較、等待切換與重新載入", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-activity-status-"));
    const store = new ActivityStore(join(dir, "events"));
    const runs = new PurchaseRuns(dir, worker);
    let runId = "";
    try {
        const a = await store.save({ ...activity, eventName: "HOLD_WAIT" });
        const b = await store.save(a.settings);
        assert.equal(runs.activityStatus(a), "尚無執行紀錄");
        const requestId = randomUUID();
        runId = runs.start(requestId, a.settings, a.id).id;
        assert.equal(runs.activityStatus(a), "執行中");
        await until(() => runs.activityStatus(a) === "等待開賣");
        const changed = await store.save(
            { ...a.settings, targets: [{ ...a.settings.targets[0]!, quantity: 3 }] },
            a.id,
        );
        assert.equal(runs.activityStatus(changed), "等待開賣");
        assert.equal(runs.activityStatus(b), "尚無執行紀錄");
        assert.throws(() => runs.start(requestId, a.settings, b.id), /更換活動/);
        await until(() => runs.activityStatus(a) === "執行中");
        await until(() => runs.snapshot()?.canCloseBrowser === true);
        assert.equal(runs.activityStatus(a), "已執行");
        assert(runs.busy());
        assert.equal(runs.activityStatus(changed), "設定已更新");
        await runs.closeBrowser(runId);
        const same = await store.save(a.settings, a.id);
        assert.equal(runs.activityStatus(same), "已執行");
        const reordered = {
            ...same,
            settings: {
                ...same.settings,
                targets: same.settings.targets.map(target => ({
                    quantity: target.quantity,
                    ticketType: target.ticketType,
                    time: target.time,
                    date: target.date,
                })),
            },
        };
        assert.equal(runs.activityStatus(reordered), "已執行");
        runId = runs.start(randomUUID(), b.settings, b.id).id;
        await until(() => runs.snapshot()?.canCloseBrowser === true);
        await runs.closeBrowser(runId);
        assert.equal(runs.activityStatus(same), "已執行");
        assert.equal(runs.activityStatus(b), "已執行");
        const restarted = new PurchaseRuns(dir, worker);
        assert.equal(restarted.activityStatus(same), "已執行");
        assert.equal(restarted.activityStatus(b), "已執行");
        assert.equal(restarted.activityStatus(changed), "設定已更新");
        restarted.close();
        await store.remove(a.id);
        const newActivity = await store.save(a.settings);
        assert.equal(runs.activityStatus(newActivity), "尚無執行紀錄");
        // 無活動關聯的舊呼叫，即使名稱/內容相同也不能歸到新活動。
        runId = runs.start(randomUUID(), newActivity.settings).id;
        await until(() => runs.snapshot()?.canCloseBrowser === true);
        await runs.closeBrowser(runId);
        assert.equal(runs.activityStatus(newActivity), "尚無執行紀錄");
    } finally {
        if (runs.snapshot()?.canCloseBrowser) await runs.closeBrowser(runId);
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});
