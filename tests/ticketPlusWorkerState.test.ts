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
                        targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 2 }],
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
    assert.equal(presentation.title, "舊版登入交接紀錄");
    assert.match(presentation.instruction, /舊版/);
    assert.doesNotMatch(presentation.instruction, /完成後會自動繼續/);
    const available = purchaseStatus(
        { ...snapshot, loginConfirmation: { confirmationId: "e3098c26-c2dc-4e96-bccc-d581f79f9ce4" } },
        false,
        Date.now(),
    );
    assert.equal(available.title, "舊版登入交接紀錄");
    assert.match(available.instruction, /舊版/);
    assert.equal(ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "login-ready" }).success, false);
    assert.equal(
        ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "queue", privateData: "secret" }).success,
        false,
    );
    assert.equal(ticketPlusEventSchema.safeParse({ type: "ticketplus", stage: "payment-ready" }).success, false);
});

test("重啟時舊 login-ready 與磁碟確認資格不能恢復人工交接", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-login-history-"));
    const confirmationId = "e3098c26-c2dc-4e96-bccc-d581f79f9ce4";
    try {
        await mkdir(join(directory, "runs"));
        await writeFile(
            join(directory, "runs", requestId + ".json"),
            JSON.stringify({
                ...record,
                snapshot: {
                    ...record.snapshot,
                    status: "running",
                    browserOpen: true,
                    events: [record.snapshot.events[0]],
                    loginConfirmation: { confirmationId },
                },
            }),
        );
        const runs = new PurchaseRuns(directory);
        assert.equal(runs.snapshot()!.status, "interrupted");
        assert.equal(runs.snapshot()!.loginConfirmation, undefined);
        assert.equal(runs.snapshot()!.canCloseBrowser, false);
        await assert.rejects(runs.confirmLogin(record.snapshot.id, confirmationId), /已停用/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("更新進度：新 stage 通過 schema 且呈現受限更新提示，歷史可重讀", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-refresh-history-"));
    try {
        await mkdir(join(directory, "runs"));
        for (const [stage, title, instruction] of [
            ["waiting-to-refresh", "等待更新票數", /仍可要求停止/],
            ["refreshing", "更新票數核對中", /未確認完成前/],
            ["refreshing-activity", "刷新活動頁", /重新載入活動頁/],
            ["waiting-for-availability", "等待目標場次開賣", /開賣後 2 分鐘/],
        ] as const) {
            const event = ticketPlusEventSchema.parse({ type: "ticketplus", stage });
            const events = [{ sequence: 1, at: "2026-10-14T00:00:00Z", event }];
            const view = purchaseStatus(
                { ...record.snapshot, platform: "ticketplus", status: "running", events },
                false,
                Date.now(),
            );
            assert.equal(view.title, title);
            assert.match(view.instruction, instruction);
            await writeFile(
                join(directory, "runs", requestId + ".json"),
                JSON.stringify({ ...record, snapshot: { ...record.snapshot, events } }),
            );
            assert.deepEqual(new PurchaseRuns(directory).snapshot()!.events, events);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("TicketPlus 付款頁結果：主服務接受 payment-ready 與送出資料頁階段，畫面顯示已到付款頁", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketplus-payment-ready-"));
    const previous = { outcome: process.env.FIXTURE_OUTCOME, stage: process.env.FIXTURE_STAGE };
    process.env.FIXTURE_OUTCOME = "payment-ready";
    process.env.FIXTURE_STAGE = "submitting-information";
    try {
        const runs = new PurchaseRuns(directory, new URL("./fixtures/ticketplus/resultWorker.ts", import.meta.url));
        runs.start(
            "1f9a3d2e-5c6b-4a7d-8e9f-0a1b2c3d4e5f",
            {
                platform: "ticketplus",
                eventUrl: "https://ticketplus.com.tw/activity/fixture",
                eventName: "付款頁活動",
                targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 }],
                maxRunMinutes: 10,
            },
            undefined,
        );
        const deadline = Date.now() + 10_000;
        while (runs.busy() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        const snapshot = runs.snapshot()!;
        assert.equal(snapshot.status, "payment-ready");
        assert(
            snapshot.events.some(
                item => item.event.type === "ticketplus" && item.event.stage === "submitting-information",
            ),
        );
        assert.equal(purchaseStatus(snapshot, false, Date.now()).title, "已到付款頁");
        runs.close();
    } finally {
        process.env.FIXTURE_OUTCOME = previous.outcome;
        process.env.FIXTURE_STAGE = previous.stage;
        if (previous.outcome === undefined) delete process.env.FIXTURE_OUTCOME;
        if (previous.stage === undefined) delete process.env.FIXTURE_STAGE;
        await rm(directory, { recursive: true, force: true });
    }
});
