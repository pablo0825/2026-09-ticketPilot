import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { ticketPlusEventSchema } from "../src/local/purchaseEvents.js";
import { purchaseStatus } from "../src/local/react/shared/runs/runPresentation.js";

// 獨立固定磁碟資料，不用待測事件產生器或 fingerprint 函式製造預期答案。
const requestId = "8f064504-7c33-43b3-b5f2-2d89e4df15d3";
const record = {
    fingerprintVersion: 4,
    fingerprint: "a".repeat(64),
    snapshot: {
        platform: "ticketplus",
        id: "123-fixture",
        requestId,
        activityName: "測試活動",
        status: "information-ready",
        browserOpen: false,
        occupied: false,
        message: "已到填寫資料頁",
        historyTruncated: false,
        events: [
            {
                sequence: 1,
                at: "2026-10-14T00:00:00Z",
                event: {
                    type: "ticketplus",
                    stage: "login-ready",
                    confirmationId: "e3098c26-c2dc-4e96-bccc-d581f79f9ce4",
                },
            },
            { sequence: 2, at: "2026-10-14T00:00:01Z", event: { type: "ticketplus", stage: "submitting" } },
        ],
    },
};

test("TicketPlus 狀態準備：新紀錄可重讀、資料頁不誤報付款、相同請求不能換設定", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-worker-state-"));
    try {
        await mkdir(join(directory, "runs"));
        const file = join(directory, "runs", requestId + ".json");
        await writeFile(file, JSON.stringify(record));
        const runs = new PurchaseRuns(directory);
        const snapshot = runs.snapshot()!;
        assert.equal(snapshot.status, "information-ready");
        assert.deepEqual(snapshot.events, record.snapshot.events);
        assert.equal(snapshot.canCloseBrowser, false); // 重啟不取得舊瀏覽器的控制權。
        assert.equal(runs.busy(), false);
        const presentation = purchaseStatus(snapshot, false, Date.now());
        assert.equal(presentation.title, "已到填寫資料頁");
        assert.match(presentation.instruction, /未核對付款結果/);
        assert.throws(
            () =>
                runs.start(
                    requestId,
                    {
                        platform: "ticketplus",
                        eventUrl: "https://ticketplus.com.tw/activity/fixture",
                        eventName: "測試活動",
                        target: { date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 },
                    },
                    undefined,
                ),
            /同一開始請求不能更換設定/,
        );
        assert.equal(runs.busy(), false);
        // 平台錯置及不合法新事件不能被當作可繼續的舊紀錄。
        await writeFile(file, JSON.stringify({ ...record, snapshot: { ...record.snapshot, platform: "klook" } }));
        assert.throws(() => new PurchaseRuns(directory), /無法讀取/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus 專用交接進度與事件 schema：不套用 Klook 自動登入提示", () => {
    const snapshot = {
        ...record.snapshot,
        status: "running" as const,
        platform: "ticketplus" as const,
        events: [
            {
                sequence: 1,
                at: "2026-10-14T00:00:00Z",
                event: ticketPlusEventSchema.parse(record.snapshot.events[0]!.event),
            },
        ],
    };
    const presentation = purchaseStatus(snapshot, false, Date.now());
    assert.equal(presentation.title, "等待人工登入確認");
    assert.doesNotMatch(presentation.instruction, /完成後會自動繼續/);
    assert.equal(ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "login-ready" }).success, false);
    assert.equal(
        ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "queue", privateData: "secret" }).success,
        false,
    );
    assert.equal(ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "payment-ready" }).success, false);
});
