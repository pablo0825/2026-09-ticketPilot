import { klookSettings } from "./fixtures/klookSettings.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { acquirePurchaseLease, purchaseOccupied, releasePurchaseLease } from "../src/app/purchaseLock.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { ActivityStore } from "../src/config/activityStore.js";
import { runPurchase } from "../src/app/runPurchase.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";
const worker = new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url);
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "fixture@example.com",
};
const activity = {
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "Fixture",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 5280, quantity: 1, adjacent: false }],
};
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
            const result = runPurchase(fixtureConfig, contact, {
                lease,
                onBrowser: () => {
                    opened = true;
                },
            });
            const rejected = assert.rejects(result, /HTTP 403/);
            await until(() => opened);
            assert.throws(() => acquirePurchaseLease(dir), /占用/);
            if (closeFirst) {
                context.emit("close");
                assert(purchaseOccupied(dir));
            }
            releaseNavigation();
            await rejected;
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
        const first = runs.start(id, activity, contact);
        assert.equal(runs.start(id, activity, contact).id, first.id);

        // 同一請求換聯絡資料或張數重送，必須拒絕，不能當成原結果。
        assert.throws(() => runs.start(id, activity, { ...contact, phone: "0987654321" }), /更換設定/);
        const changedQuantity = { ...activity, targets: [{ ...activity.targets[0]!, quantity: 2 }] };
        assert.throws(() => runs.start(id, changedQuantity, contact), /更換設定/);
        await until(() => runs.snapshot()?.status === "payment-ready");
        assert(runs.busy());
        assert.throws(() => runs.start(randomUUID(), activity, contact), /占用/);
        assert.throws(() => runs.close(), /尚未結束/);
        await until(() => !runs.busy());
        assert.equal(runs.snapshot()?.status, "payment-ready");
        runs.close();
        const restarted = new PurchaseRuns(dir, worker);
        assert.equal(restarted.start(id, activity, contact).id, first.id);
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
        assert.throws(() => runs.start(randomUUID(), {}, contact));
        assert(!purchaseOccupied(dir));
        const id = randomUUID();
        const data = { ...activity, eventName: "CRASH" };
        const record = await new ActivityStore(join(dir, "events")).save(data);
        const started = runs.start(id, data, contact, record.id);
        await until(() => runs.snapshot()?.status === "interrupted");
        assert.equal(runs.snapshot()?.id, started.id);
        assert.equal(runs.snapshot()?.platform, "klook");
        assert.equal(runs.snapshot()?.activityName, "CRASH");
        assert.match(runs.snapshot()!.message, /異常/);
        assert.equal(runs.activityStatus(record), "已執行");
        assert(purchaseOccupied(dir));
        runs.close();
        const next = new PurchaseRuns(dir, worker);
        assert.equal(next.snapshot()?.id, started.id);
        assert.equal(next.snapshot()?.platform, "klook");
        assert.equal(next.start(id, data, contact, record.id).status, "interrupted");
        assert.equal(next.activityStatus(record), "已執行");
        assert.throws(() => next.start(randomUUID(), activity, contact), /占用/);
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
            const first = runs.start(requestId, data, contact);
            await assert.rejects(runs.closeBrowser(first.id), /仍在執行/);
            await until(() => runs.snapshot()?.canCloseBrowser === true);
            assert.equal(runs.start(requestId, data, contact).canCloseBrowser, true);
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
    const runs = new PurchaseRuns(dir, new URL("./fixtures/closeBrowserWorker.ts", import.meta.url));
    try {
        const first = runs.start(randomUUID(), activity, contact);
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
        runId = runs.start(requestId, a.settings, contact, a.id).id;
        assert.equal(runs.activityStatus(a), "執行中");
        await until(() => runs.activityStatus(a) === "等待開賣");
        const changed = await store.save(
            { ...a.settings, targets: [{ ...klookSettings(a.settings).targets[0]!, quantity: 2 }] },
            a.id,
        );
        assert.equal(runs.activityStatus(changed), "等待開賣");
        assert.equal(runs.activityStatus(b), "尚無執行紀錄");
        assert.throws(() => runs.start(requestId, a.settings, contact, b.id), /更換活動/);
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
                ...klookSettings(same.settings),
                targets: klookSettings(same.settings).targets.map(target => ({
                    adjacent: target.adjacent,
                    quantity: target.quantity,
                    area: target.area,
                    time: target.time,
                    date: target.date,
                })),
            },
        };
        assert.equal(runs.activityStatus(reordered), "已執行");
        runId = runs.start(randomUUID(), b.settings, { ...contact, phone: "0999999999" }, b.id).id;
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
        runId = runs.start(randomUUID(), newActivity.settings, contact).id;
        await until(() => runs.snapshot()?.canCloseBrowser === true);
        await runs.closeBrowser(runId);
        assert.equal(runs.activityStatus(newActivity), "尚無執行紀錄");
    } finally {
        if (runs.snapshot()?.canCloseBrowser) await runs.closeBrowser(runId);
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

for (const version of [undefined, 2, 3]) {
    test(`舊指紋 ${version ?? "無版本"} 與事件可讀；同一舊請求不得重新啟動`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "ticket-legacy-currency-"));
        const store = new ActivityStore(join(dir, "events"));
        try {
            // 建立更新前的持久化格式，不能用新雜湊函式製作測試資料
            const record = await store.save(activity);
            const requestId = randomUUID();
            const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
            const legacy = {
                ...(version === undefined ? {} : { fingerprintVersion: version }),
                fingerprint: hash({ activity, contact }),
                activity: { id: record.id, settingsHash: hash(activity) },
                snapshot: {
                    id: `1-${requestId}`,
                    requestId,
                    activityName: activity.eventName,
                    status: "failed",
                    browserOpen: false,
                    occupied: false,
                    message: "已停止",
                    historyTruncated: false,
                    events: [
                        {
                            sequence: 1,
                            at: new Date().toISOString(),
                            event: {
                                type: "target",
                                index: 1,
                                total: 1,
                                area: "B區",
                                quantity: 1,
                                date: "2026-11-02",
                                time: "19:30",
                                totalPrice: 5280,
                            },
                        },
                    ],
                },
            };
            await mkdir(join(dir, "runs"));
            await writeFile(join(dir, "runs", `${requestId}.json`), JSON.stringify(legacy));

            // 舊指紋不能安全轉換，保留紀錄並拒絕重新啟動
            const runs = new PurchaseRuns(dir, worker);
            assert.equal(runs.activityStatus(record), "舊版執行紀錄");
            assert.throws(() => runs.start(requestId, activity, contact, record.id), /舊版開始請求/);
            assert.throws(
                () => runs.start(requestId, { ...activity, currency: "TWD" }, contact, record.id),
                /舊版開始請求/,
            );
            const event = runs.snapshot()!.events[0]!.event;
            assert.equal(event.type === "target" && event.quantity, 1);

            // 舊金額值改變也不能重啟舊請求
            const hk = await store.save({ ...activity, currency: "HKD" }, record.id);
            assert.equal(runs.activityStatus(hk), "舊版執行紀錄");
            assert.throws(() => runs.start(requestId, hk.settings, contact, record.id), /舊版開始請求/);
            assert.equal(runs.busy(), false);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
}

test("Klook 固定 v4 指紋相容：重送舊請求直接讀回，不建立占用或 fork", async () => {
    const dir = await mkdtemp(join(tmpdir(), "klook-fixed-v4-"));
    const requestId = "6f117b18-7761-4527-961f-9284f0fa82df";
    try {
        await mkdir(join(dir, "runs"));
        // 在本次改動前的 {activity,contact} 格式獨立計算並固定；不以待測 helper 生成。
        await writeFile(
            join(dir, "runs", requestId + ".json"),
            JSON.stringify({
                fingerprintVersion: 4,
                fingerprint: "640918dec9d41418fa481e531e2ee3082da44a8f46a4995e8bba64a2139e62f0",
                snapshot: {
                    platform: "klook",
                    id: "1-fixed-v4",
                    requestId,
                    activityName: "Fixture",
                    status: "payment-ready",
                    browserOpen: false,
                    occupied: false,
                    message: "舊結果",
                    events: [],
                    historyTruncated: false,
                },
            }),
        );
        // 不存在的 worker：錯誤地 fork 將不能成功，另檢查鎖與結果 ID。
        const runs = new PurchaseRuns(dir, new URL("./fixtures/does-not-exist.ts", import.meta.url));
        const result = runs.start(requestId, activity, contact);
        assert.equal(result.id, "1-fixed-v4");
        assert.equal(result.status, "payment-ready");
        assert.equal(runs.busy(), false);
        assert.equal(purchaseOccupied(dir), false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("TicketPlus 停止入口不控制正在執行的 Klook worker", async t => {
    const dir = await mkdtemp(join(tmpdir(), "klook-stop-boundary-"));
    const runs = new PurchaseRuns(dir, worker);
    const originalEmit = ChildProcess.prototype.emit;
    let stops = 0;
    let checkStop: Promise<void> | undefined;
    let spawned = () => {};
    const ready = new Promise<void>(resolve => {
        spawned = resolve;
    });
    try {
        // 在 spawn 當下檢查，避免輪詢等待耗掉 fixture 的執行時間。
        t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: any[]) {
            if (event === "spawn") {
                assert.equal(this.connected, true);
                const originalSend = this.send;
                t.mock.method(this, "send", function (this: ChildProcess, message: any, ...sendArgs: any[]) {
                    if (message?.type === "stop-ticketplus") stops++;
                    return Reflect.apply(originalSend, this, [message, ...sendArgs]);
                });
                assert.equal(runs.snapshot()!.status, "running");
                assert.equal(runs.snapshot()!.canStop, false);
                checkStop = assert.rejects(runs.stop(runs.snapshot()!.id));
                spawned();
            }
            return Reflect.apply(originalEmit, this, [event, ...args]);
        });
        const started = runs.start(randomUUID(), { ...activity, eventName: "HOLD_WAIT" }, contact);
        await ready;
        await checkStop;
        assert.equal(stops, 0);
        await until(() => runs.snapshot()?.status === "payment-ready");
        await runs.closeBrowser(started.id);
        await until(() => !runs.busy());
    } finally {
        t.mock.restoreAll();
        if (runs.snapshot()?.canCloseBrowser) await runs.closeBrowser(runs.snapshot()!.id);
        await until(() => !runs.busy());
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});
