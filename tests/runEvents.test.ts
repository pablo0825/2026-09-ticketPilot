import { test } from "node:test";
import assert from "node:assert/strict";
import { withRunEvents, log, type RunEvent } from "../src/core/logger.js";
import { reportState } from "../src/core/state.js";

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
