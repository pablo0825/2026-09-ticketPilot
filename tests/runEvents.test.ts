import { test } from "node:test";
import assert from "node:assert/strict";
import { withRunEvents, log, type RunEvent } from "../src/core/logger.js";
import { reportState } from "../src/core/state.js";
import { runPurchase } from "../src/app/runPurchase.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";

test("執行事件包含巢狀狀態且不同 listener 隔離；顯示失敗不改變流程", async () => {
    const events: RunEvent[] = [];
    await withRunEvents(
        event => events.push(event),
        async () => {
            reportState("RECOVERING");
            await withRunEvents(
                () => {
                    throw new Error("UI 離線");
                },
                async () => log("另一工作"),
            );
            log("原工作");
        },
    );
    assert(events.some(e => e.type === "state" && e.state === "RECOVERING"));
    assert(!events.some(e => e.type === "log" && e.message === "另一工作"));
});

test("匯入共用 runner 不執行；無效個資呼叫在瀏覽器之前拒絕", async () => {
    await assert.rejects(
        runPurchase(fixtureConfig, {} as never, {
            onBrowser: () => {
                assert.fail("不得開瀏覽器");
            },
        }),
        /請填寫名字/,
    );
});

test("非同步狀態接收端失敗也不造成未處理拒絕", async () => {
    await withRunEvents(
        async () => {
            throw new Error("非同步 UI 斷線");
        },
        async () => {
            reportState("READY");
            await new Promise(resolve => setImmediate(resolve));
        },
    );
});

test("關閉模擬服務會停止子程序並標記中斷，不會自動續跑", async () => {
    const { SimulationRuns } = await import("../src/local/simulationRuns.js");
    const { randomUUID } = await import("node:crypto");
    const runs = new SimulationRuns();
    const activity = {
        eventUrl: "https://www.klook.com/zh-TW/event-detail/test/",
        eventName: "中斷測試",
        fallbackMode: "STRICT",
        excludeKeywords: [],
        targets: [{ date: "2026-11-02", time: "19:30", area: "B區", unitPrice: 100, quantity: 1, adjacent: false }],
    };
    const contact = {
        firstName: "Demo",
        lastName: "Test",
        regionLabel: "台灣 (+886)",
        phone: "0912345678",
        email: "demo@example.com",
    };
    const id = randomUUID();
    const before = runs.start(id, activity, contact);
    await runs.close();
    assert.equal(runs.snapshot()!.status, "interrupted");
    assert.equal(runs.start(id, activity, contact).id, before.id);
    assert.equal(runs.snapshot()!.status, "interrupted");
});
