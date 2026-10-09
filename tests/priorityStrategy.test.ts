import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { PriorityStrategy, type TargetAttempt } from "../src/core/priorityStrategy.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";

const config = {
    ...eventConfig,
    targets: ["A區", "B區"].map((area, index) => ({
        ...eventConfig.targets[0]!,
        area,
        expectation: { eventName: "fixture", unitPrice: 4880 - index * 1000, totalPrice: 4880 - index * 1000 },
    })),
};
const recovery = () => ({
    active: false,
    count: 0,
    async isRequired() {
        return this.active;
    },
    async recover() {
        this.count++;
        this.active = false;
    },
});

test("A 失敗不扣恢復額度；B 個資過期後仍試 B，回傳新座位與 B 價格", async () => {
    const strategy = new PriorityStrategy(config);
    const queue = recovery();
    const contact = recovery();
    const attempts: string[] = [];
    let returns = 0;
    const adapter: TargetAttempt<number> = {
        async attempt(target) {
            attempts.push(target.area);
            return target.area === "A區"
                ? { status: "unavailable", reason: "sold-out" }
                : { status: "matched", value: attempts.length };
        },
        async returnAfterFailure() {
            returns++;
        },
    };
    const result = await prepareBooking(
        {
            selectSeats: () => strategy.select(adapter),
            confirmSeats: async () => {},
            prepareContact: async value => {
                if (value.value === 2) contact.active = true;
            },
        },
        queue,
        contact,
    );
    assert.deepEqual(attempts, ["A區", "B區", "B區"]);
    assert.equal(result.value, 3);
    assert.equal(result.target.expectation.totalPrice, 3880);
    assert.equal(returns, 1);
    assert.equal(queue.count, 0);
    assert.equal(contact.count, 1);
});

test("返回失敗即終止，即使排隊過期也不接手；全部失敗不重啟一輪", async () => {
    const queue = recovery();
    let attempts = 0;
    const strategy = new PriorityStrategy(config);
    await assert.rejects(
        prepareBooking(
            {
                selectSeats: () =>
                    strategy.select({
                        async attempt() {
                            attempts++;
                            return { status: "unavailable", reason: "assignment-failed" };
                        },
                        async returnAfterFailure() {
                            queue.active = true;
                            throw new Error("timeout");
                        },
                    }),
                confirmSeats: async () => {},
                prepareContact: async () => {},
            },
            queue,
            recovery(),
        ),
        PurchaseStop,
    );
    assert.equal(queue.count, 0);
    assert.equal(attempts, 1);
    const exhausted = new PriorityStrategy(config);
    let count = 0;
    const adapter: TargetAttempt<void> = {
        async attempt() {
            count++;
            return { status: "unavailable", reason: "sold-out" };
        },
        async returnAfterFailure() {},
    };
    await assert.rejects(exhausted.select(adapter), /NO_TARGET_AVAILABLE/);
    await assert.rejects(exhausted.select(adapter), /NO_TARGET_AVAILABLE/);
    assert.equal(count, 2);
});

test("啟動驗證所有順位，拒絕後續目標的錯價格、日期、排除詞", () => {
    for (const target of [
        { ...config.targets[1]!, expectation: { ...config.targets[1]!.expectation, totalPrice: 0 } },
        { ...config.targets[1]!, date: "2026-02-30" },
        { ...config.targets[1]!, area: "愛心席" },
    ])
        assert.throws(() => new PriorityStrategy({ ...config, targets: [config.targets[0]!, target] }));
});

test("假設 DOM：兩種失敗提示、延遲返回與不返回；只按一次，返回完成才選 B", async () => {
    // 此 fixture 並非已觀察的 Klook DOM，不能拿來啟用實站 selector。
    const browser = await chromium.launch();
    try {
        for (const message of ["已經沒有票了", "選位失敗，請重試"]) {
            for (const returns of [true, false]) {
                const page = await browser.newPage();
                await page.setContent(
                    `<div id="fixture-dialog">${message}<button onclick="window.clicks=(window.clicks||0)+1;${returns ? "setTimeout(()=>{document.body.innerHTML='<div id=fixture-ready>ready</div>'},100)" : ""}">OK</button></div>`,
                );
                const attempts: string[] = [];
                const result = new PriorityStrategy(config).select({
                    async attempt(target) {
                        attempts.push(target.area);
                        if (target.area === "A區")
                            return { status: "unavailable" as const, reason: "sold-out" as const };
                        assert.equal(await page.locator("#fixture-ready").count(), 1);
                        return { status: "matched" as const, value: target.area };
                    },
                    async returnAfterFailure() {
                        await page.getByRole("button", { name: "OK", exact: true }).click();
                        await page.locator("#fixture-ready").waitFor({ timeout: 500 });
                    },
                });
                if (returns) assert.equal((await result).value, "B區");
                else await assert.rejects(result, PurchaseStop);
                assert.deepEqual(attempts, returns ? ["A區", "B區"] : ["A區"]);
                assert.equal(await page.evaluate("window.clicks"), 1);
                await page.close();
            }
        }
    } finally {
        await browser.close();
    }
});

test("A 換 B 後排隊與預留各一次；再次排隊停止，順位與額度不重設", async () => {
    const strategy = new PriorityStrategy(config);
    const queue = recovery();
    const contact = recovery();
    const attempts: string[] = [];
    await assert.rejects(
        prepareBooking(
            {
                selectSeats: () =>
                    strategy.select({
                        async attempt(target) {
                            attempts.push(target.area);
                            if (target.area === "A區") return { status: "unavailable", reason: "sold-out" };
                            if (attempts.length === 2 || attempts.length === 4) {
                                queue.active = true;
                                throw new Error("queue expired");
                            }
                            return { status: "matched", value: attempts.length };
                        },
                        async returnAfterFailure() {},
                    }),
                confirmSeats: async () => {},
                prepareContact: async () => {
                    contact.active = true;
                },
            },
            queue,
            contact,
        ),
        /一次恢復上限/,
    );
    assert.deepEqual(attempts, ["A區", "B區", "B區", "B區"]);
    assert.equal(queue.count, 1);
    assert.equal(contact.count, 1);
});

test("排除目標不呼叫 adapter；未知錯誤不返回或換順位", async () => {
    let calls = 0;
    const adapter: TargetAttempt<void> = {
        async attempt() {
            calls++;
            throw new Error("UNKNOWN");
        },
        async returnAfterFailure() {
            assert.fail("未知錯誤不可返回換區");
        },
    };
    assert.throws(() => new PriorityStrategy({ ...config, excludeKeywords: ["A區"] }), /排除條件/);
    assert.equal(calls, 0);
    await assert.rejects(new PriorityStrategy(config).select(adapter), /UNKNOWN/);
    assert.equal(calls, 1);
});
