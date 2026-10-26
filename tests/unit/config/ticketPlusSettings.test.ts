import assert from "node:assert/strict";
import { test } from "node:test";
import {
    parseTicketPlusActivity,
    ticketPlusFlowType,
} from "../../../src/config/platforms/ticketplus/activitySettings.js";
import { parseActivity } from "../../../src/config/activitySettings.js";

function validActivity() {
    return {
        platform: "ticketplus",
        eventUrl: "https://ticketplus.com.tw/activity/0233a891800ffaa343bf8bff73d390e8",
        eventName: "2026孿生姐妹之夜之鬼迷心竅",
        targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票", quantity: 1 }],
    };
}

test("TicketPlus 設定保留購票順位，整理名稱外側空白但不修改輸入", () => {
    // 準備帶有空白的名稱並保留原始輸入
    const input = validActivity();
    input.eventName = "  音樂會 A  B  ";
    input.targets[0]!.ticketType = "  預售票 A  區  ";
    const before = structuredClone(input);

    // 確認只整理外側空白，保留內部文字
    const parsed = parseTicketPlusActivity(input);
    assert.deepEqual(parsed, {
        platform: "ticketplus",
        eventUrl: "https://ticketplus.com.tw/activity/0233a891800ffaa343bf8bff73d390e8",
        eventName: "音樂會 A  B",
        targets: [{ date: "2026-10-30", time: "20:00", ticketType: "預售票 A  區", quantity: 1 }],
    });
    // 確認解析與後續修改都不影響原始輸入
    assert.deepEqual(input, before);
    parsed.targets[0]!.quantity = 2;
    assert.equal(input.targets[0]!.quantity, 1);
});

test("TicketPlus 僅接受活動網址，不將單一樣本的 ID 格式當成全站限制", () => {
    // 接受活動入口與允許的結尾斜線
    for (const eventUrl of [
        validActivity().eventUrl,
        validActivity().eventUrl + "/",
        "https://ticketplus.com.tw/activity/event_ABC-123",
    ]) {
        assert.equal(parseTicketPlusActivity({ ...validActivity(), eventUrl }).eventUrl, eventUrl);
    }

    // 拒絕其他來源、非活動頁及額外網址成分
    for (const eventUrl of [
        "http://ticketplus.com.tw/activity/abc",
        "https://ticketplus.com.tw.evil.example/activity/abc",
        "https://www.ticketplus.com.tw/activity/abc",
        "https://user:password@ticketplus.com.tw/activity/abc",
        "https://ticketplus.com.tw@evil.example/activity/abc",
        "https://ticketplus.com.tw:443/activity/abc",
        "https://ticketplus.com.tw:8443/activity/abc",
        "https://ticketplus.com.tw/activity/",
        "https://ticketplus.com.tw/activity/abc/extra",
        "https://ticketplus.com.tw/other/../activity/abc",
        "https://ticketplus.com.tw/activity/abc?source=test",
        "https://ticketplus.com.tw/activity/abc#buy",
        "https://ticketplus.com.tw/order/abc/session",
        "https://ticketplus.com.tw/confirm/abc/session",
        "https://ticketplus.com.tw/checkout/abc/session",
        "not a URL",
    ]) {
        assert.throws(() => parseTicketPlusActivity({ ...validActivity(), eventUrl }), /TicketPlus/, eventUrl);
    }
});

test("TicketPlus 驗證真實日期與完整時間，不要求日期必須在未來", () => {
    // 接受有效日期，拒絕格式正確但不存在的日期
    for (const date of ["2028-02-29", "2000-02-29", "2020-01-01"]) {
        const input = validActivity();
        input.targets[0]!.date = date;
        assert.equal(parseTicketPlusActivity(input).targets[0]!.date, date);
    }
    for (const date of [
        "2026-02-29",
        "2026-02-30",
        "1900-02-29",
        "2026-04-31",
        "2026-13-01",
        "2026-01-00",
        "2026-1-01",
        "",
    ]) {
        const input = validActivity();
        input.targets[0]!.date = date;
        assert.throws(() => parseTicketPlusActivity(input), /TicketPlus/, date);
    }

    // 檢查時間邊界與固定格式
    for (const time of ["00:00", "23:59"]) {
        const input = validActivity();
        input.targets[0]!.time = time;
        assert.equal(parseTicketPlusActivity(input).targets[0]!.time, time);
    }
    for (const time of ["24:00", "19:60", "9:30", "20:00:00", " 20:00", ""]) {
        const input = validActivity();
        input.targets[0]!.time = time;
        assert.throws(() => parseTicketPlusActivity(input), /TicketPlus/, time);
    }
});

test("TicketPlus 張數只接受正安全整數，不猜測網站限購上限", () => {
    for (const quantity of [1, 5, Number.MAX_SAFE_INTEGER]) {
        const input = validActivity();
        input.targets[0]!.quantity = quantity;
        assert.equal(parseTicketPlusActivity(input).targets[0]!.quantity, quantity);
    }
    for (const quantity of [0, -1, 1.5, "2", null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const input = validActivity();
        assert.throws(
            () => parseTicketPlusActivity({ ...input, targets: [{ ...input.targets[0]!, quantity }] }),
            /TicketPlus/,
        );
    }
});

test("TicketPlus 缺少必填欄位、未知平台及不適用欄位均拒絕", () => {
    // 逐一移除必填欄位，確認沒有偷偷補預設值
    for (const field of ["platform", "eventUrl", "eventName", "targets"]) {
        const input: Record<string, unknown> = validActivity();
        delete input[field];
        assert.throws(() => parseTicketPlusActivity(input), /TicketPlus/, field);
    }
    for (const field of ["date", "time", "ticketType", "quantity"]) {
        const input = validActivity();
        const target: Record<string, unknown> = { ...input.targets[0]! };
        delete target[field];
        assert.throws(() => parseTicketPlusActivity({ ...input, targets: [target] }), /TicketPlus/, field);
    }

    // 拒絕其他平台、空白名稱及不適用欄位
    for (const patch of [
        { platform: "klook" },
        { platform: "unknown" },
        { eventName: " \n " },
        { adjacent: false },
        { queueEnabled: true },
        { targets: [] },
    ]) {
        assert.throws(() => parseTicketPlusActivity({ ...validActivity(), ...patch }), /TicketPlus/);
    }
    for (const patch of [{ ticketType: " \n " }, { area: "A區" }, { adjacent: false }, { bundle: "套票" }]) {
        const input = validActivity();
        assert.throws(
            () => parseTicketPlusActivity({ ...input, targets: [{ ...input.targets[0]!, ...patch }] }),
            /TicketPlus/,
        );
    }
    // 拒絕錯誤的整體資料結構
    for (const input of [null, undefined, [], "ticketplus", { ...validActivity(), targets: {} }]) {
        assert.throws(() => parseTicketPlusActivity(input), /TicketPlus/);
    }
});

test("合法 TicketPlus 設定可解析，但不能轉成 Klook 購票設定", () => {
    const input = validActivity();
    assert.equal(parseTicketPlusActivity(input).platform, "ticketplus");
    assert.deepEqual(parseActivity(input), parseTicketPlusActivity(input));
});

test("TicketPlus 流程類型：舊設定視為購票，抽選可解析，未知值拒絕", () => {
    // 舊設定沒有流程類型時視為購票，且解析結果不補欄位
    const legacy = parseTicketPlusActivity(validActivity());
    assert.equal(ticketPlusFlowType(legacy), "purchase");
    assert.equal("flowType" in legacy, false);

    // 明確設定的兩種類型都保留
    const lottery = parseTicketPlusActivity({ ...validActivity(), flowType: "lottery" });
    assert.equal(lottery.flowType, "lottery");
    assert.equal(ticketPlusFlowType(lottery), "lottery");
    assert.equal(ticketPlusFlowType(parseTicketPlusActivity({ ...validActivity(), flowType: "purchase" })), "purchase");

    // 未知類型沿用原本的設定錯誤訊息
    assert.throws(
        () => parseTicketPlusActivity({ ...validActivity(), flowType: "seated" }),
        /TicketPlus 活動設定格式錯誤.*流程類型/,
    );
});
