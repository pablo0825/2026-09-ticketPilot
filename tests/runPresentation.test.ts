import assert from "node:assert/strict";
import { test } from "node:test";
import type { PurchaseSnapshot } from "../src/server/runs/purchaseRuns.js";
import type { PurchaseEvent } from "../src/shared/runEvents.js";
import { purchaseStatus } from "../src/local/react/shared/runs/runPresentation.js";

const now = Date.parse("2026-10-19T07:00:00Z");
const general = { title: "正在購票", instruction: "程式正在依照設定執行，請稍候。" };

function snapshot(events: PurchaseEvent[] = [], fields: Partial<PurchaseSnapshot> = {}): PurchaseSnapshot {
    return {
        id: "presentation-fixture",
        requestId: "presentation-request",
        activityName: "測試活動",
        platform: "ticketplus",
        status: "running",
        browserOpen: true,
        occupied: true,
        message: "",
        historyTruncated: false,
        events: events.map((event, sequence) => ({ event, sequence, at: "2026-10-19T07:00:00Z" })),
        ...fields,
    };
}

test("階段分流：保留無事件回退、平台隔離與最近階段優先", () => {
    // 沒有 TicketPlus 事件時，仍可使用最近的 state。
    const state: PurchaseEvent = { type: "state", state: "WAITING_FOR_LOGIN" };
    const login = { title: "請手動登入", instruction: "請到購票瀏覽器完成登入，完成後會自動繼續。" };
    assert.deepEqual(purchaseStatus(snapshot(), false, now), general);
    assert.deepEqual(purchaseStatus(snapshot([state]), false, now), login);

    // 已知的一般階段不會回退套用舊版提示。
    for (const stage of ["starting", "selecting-session", "selecting-tickets"] as const) {
        const run = snapshot([{ type: "ticketplus", stage: "queue" }, { type: "ticketplus", stage }, state]);
        assert.deepEqual(purchaseStatus(run, false, now), general);
    }

    // 未知平台忽略 TicketPlus 事件，未知階段保留一般提示。
    const events: PurchaseEvent[] = [state, { type: "ticketplus", stage: "queue" }];
    for (const platform of [null] as const) {
        assert.deepEqual(purchaseStatus(snapshot(events, { platform }), false, now), login);
    }
    const futureEvent = { type: "ticketplus", stage: "future-stage" } as unknown as PurchaseEvent;
    assert.deepEqual(purchaseStatus(snapshot([state, futureEvent]), false, now), general);
});

test("停止提示只覆蓋執行中的 TicketPlus，關閉提示只覆蓋已結束流程", () => {
    // 停止要求優先於階段，執行中不套用關閉提示。
    const events: PurchaseEvent[] = [{ type: "ticketplus", stage: "queue" }];
    const run = snapshot(events, { stopRequest: { status: "sent" } });
    assert.deepEqual(purchaseStatus(run, true, now), {
        title: "等待流程停止",
        instruction: "已送出停止要求，尚不代表流程已停止；請查看後續執行結果。",
    });
    assert.deepEqual(purchaseStatus({ ...run, platform: null }, true, now), general);

    // 結束後忽略停止要求與舊進度，關閉時保留結果標題。
    for (const [status, title] of [
        ["information-ready", "已到填寫資料頁"],
        ["registration-ready", "已停在確認登記前"],
        ["payment-ready", "已到付款頁"],
        ["failed", "購票已停止"],
        ["unknown", "購票已停止"],
        ["interrupted", "購票已停止"],
    ] as const) {
        for (const browserOpen of [false, true]) {
            for (const occupied of [false, true]) {
                const finished = { ...run, status, browserOpen, occupied };
                assert.equal(purchaseStatus(finished, false, now).title, title);
                assert.deepEqual(purchaseStatus(finished, true, now), {
                    title,
                    instruction: "正在關閉購票瀏覽器，請稍候；確認程序結束後才會解除占用。",
                });
            }
        }
    }
});

test("開賣倒數：保留新舊事件格式、進位、跨零與無效時間提示", () => {
    // 固定時鐘，分別驗證新舊事件文字與日期格式。
    for (const legacy of [false, true]) {
        const event: PurchaseEvent = !legacy
            ? { type: "ticketplus", stage: "waiting-for-sale" }
            : { type: "state", state: "WAITING_FOR_SALE" };
        const saleAt = "2026-10-19T07:00:01.001Z";
        const run = snapshot([event], { saleAt });
        const date = new Date(saleAt).toLocaleString("zh-TW", {
            timeZone: "Asia/Taipei",
            ...(!legacy ? { hour12: false } : {}),
        });
        const prefix = `開賣時間：${date}（台灣時間）。`;
        assert.deepEqual(purchaseStatus(run, false, now), {
            title: "等待開賣",
            instruction:
                prefix + (!legacy ? "距開賣 2 秒；程式會依設定提前刷新活動頁。" : "距開賣 2 秒，程式會自動繼續。"),
        });

        // 到點與過期都只顯示等待，不出現負數倒數。
        for (const clock of [Date.parse(saleAt), Date.parse(saleAt) + 1000]) {
            assert.equal(
                purchaseStatus(run, false, clock).instruction,
                prefix +
                    (!legacy
                        ? "已到設定時間，等待購票程序更新進度；不會由此畫面重新啟動。"
                        : "已到設定時間，正在等待開賣頁面。"),
            );
        }
        for (const invalid of [undefined, "", "invalid"]) {
            assert.equal(
                purchaseStatus({ ...run, saleAt: invalid }, false, now).instruction,
                !legacy ? "等待指定開賣時間，程式會依設定提前刷新活動頁。" : "正在等待設定的開賣時間，程式會自動繼續。",
            );
        }
    }
});
