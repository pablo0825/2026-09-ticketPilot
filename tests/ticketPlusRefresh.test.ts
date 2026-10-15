import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { refreshTicketPlusTickets } from "../src/platforms/ticketplus/ticketRefresh.js";
import { TicketPlusRunControl } from "../src/platforms/ticketplus/runControl.js";
import { installQuantityFixture, quantityState } from "./fixtures/ticketplus/quantityPage.js";

const session = {
    eventId: "event-fixture",
    sessionId: "session-B",
    eventName: "2026孿生姐妹之夜之鬼迷心竅",
    date: "2026-10-30",
    time: "20:00",
};
async function withPage(run: (page: Page) => Promise<void>) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await installQuantityFixture(page, { count: 0 });
        await run(page);
        const { clicks } = await quantityState(page);
        for (const [key, value] of Object.entries(clicks)) if (key !== "refresh") assert.equal(value, 0, key);
    } finally {
        await browser.close();
    }
}

test("TicketPlus 更新：實際按一次，但完整舊畫面不能當完成證據", async () => {
    await withPage(async page => {
        assert.deepEqual(await refreshTicketPlusTickets(page, session, new TicketPlusRunControl()), {
            kind: "stopped",
            reason: "completion-unverified",
            clickAttempted: true,
        });
        assert.equal((await quantityState(page)).clicks.refresh, 1);
        assert.deepEqual((await quantityState(page)).counts, { student: "0", presale: "0" });
    });
});

test("TicketPlus 更新：任何已選張數、錯場次、未知彈窗與壞票列都阻擋點擊", async () => {
    for (const mutation of ["selected", "session", "dialog", "broken"] as const) {
        await withPage(async page => {
            await page.evaluate(mutation => {
                if (mutation === "selected")
                    document.querySelector('[data-fixture="student"] .count-button > div')!.textContent = "1";
                if (mutation === "session") history.replaceState(null, "", "/order/event-fixture/other");
                if (mutation === "dialog")
                    document.body.insertAdjacentHTML("beforeend", '<div role="dialog">未知錯誤</div>');
                if (mutation === "broken") document.querySelector('[data-fixture="student"] .count-button')!.remove();
            }, mutation);
            const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            assert.equal(result.clickAttempted, false);
            assert.equal(
                result.reason,
                mutation === "selected"
                    ? "remaining-quantity"
                    : mutation === "session"
                      ? "identity-mismatch"
                      : "unexpected-page",
            );
            assert.equal((await quantityState(page)).clicks.refresh, 0);
        });
    }
});

test("TicketPlus 更新：重複可見或停用按鈕阻擋，隱藏副本不造成歧義", async () => {
    for (const variant of ["duplicate", "disabled", "hidden"] as const) {
        await withPage(async page => {
            await page.evaluate(variant => {
                const button = document.querySelector<HTMLButtonElement>('[data-fixture-action="refresh"]')!;
                if (variant === "disabled") button.disabled = true;
                else {
                    const copy = button.cloneNode(true) as HTMLElement;
                    copy.hidden = variant === "hidden";
                    document.body.append(copy);
                }
            }, variant);
            const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            assert.equal(result.reason, variant === "hidden" ? "completion-unverified" : "button-unavailable");
            assert.equal((await quantityState(page)).clicks.refresh, variant === "hidden" ? 1 : 0);
        });
    }
});

test("TicketPlus 更新：點擊後換場次或出現殘留張數不放行，也不補按", async () => {
    for (const variant of ["session", "quantity"] as const) {
        await withPage(async page => {
            await page.evaluate(
                variant =>
                    document.addEventListener("click", event => {
                        if (!(event.target as Element).closest('[data-fixture-action="refresh"]')) return;
                        if (variant === "session") history.replaceState(null, "", "/order/event-fixture/other");
                        else document.querySelector('[data-fixture="presale"] .count-button > div')!.textContent = "1";
                    }),
                variant,
            );
            const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl());
            assert.equal(result.reason, variant === "session" ? "identity-mismatch" : "remaining-quantity");
            assert.equal(result.clickAttempted, true);
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        });
    }
});

test("TicketPlus 更新：點擊前停止或期限已到，完全不操作", async () => {
    await withPage(async page => {
        const controller = new AbortController();
        controller.abort();
        assert.equal(
            (await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(controller.signal))).stopReason,
            "user-stop",
        );
        let now = 0;
        const control = new TicketPlusRunControl(undefined, () => now);
        control.startDeadline(1);
        now = 60000;
        assert.equal((await refreshTicketPlusTickets(page, session, control)).stopReason, "time-limit");
        assert.equal((await quantityState(page)).clicks.refresh, 0);
    });
});

test("TicketPlus 更新：遮罩造成原生點擊逾時，遮罩移除後也不會晚到補按", async () => {
    await withPage(async page => {
        await page.evaluate(() =>
            document.body.insertAdjacentHTML(
                "beforeend",
                '<div id="cover" style="position:fixed;inset:0;z-index:999;background:white"></div>',
            ),
        );
        const result = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), {
            clickTimeoutMs: 100,
        });
        assert.deepEqual(result, { kind: "stopped", reason: "click-failed", clickAttempted: true });
        await page.locator("#cover").evaluate(element => element.remove());
        assert.equal((await quantityState(page)).clicks.refresh, 0);
    });
});

test("TicketPlus 更新：在途讀取停止或局部逾時，不會被晚到 DOM 放行", async context => {
    await withPage(async page => {
        const original = page.evaluate.bind(page);
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => {
            entered = resolve;
        });
        const held = new Promise<void>(resolve => {
            release = resolve;
        });
        const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
            entered();
            await held;
            return original(...args);
        });
        try {
            const controller = new AbortController();
            const pending = refreshTicketPlusTickets(page, session, new TicketPlusRunControl(controller.signal));
            await started;
            controller.abort();
            assert.equal((await pending).stopReason, "user-stop");
            const timed = await refreshTicketPlusTickets(page, session, new TicketPlusRunControl(), { timeoutMs: 40 });
            assert.equal(timed.reason, "operation-timeout");
        } finally {
            release();
            mock.mock.restore();
        }
        assert.equal((await quantityState(page)).clicks.refresh, 0);
    });
});

test("TicketPlus 更新：已點擊後讀取遇到停止或到期，保留嘗試事實且不回報完成", async context => {
    for (const mode of ["stop", "deadline"] as const) {
        await withPage(async page => {
            const controller = new AbortController();
            let now = 0;
            const control = new TicketPlusRunControl(controller.signal, () => now);
            control.startDeadline(1);
            const original = page.evaluate.bind(page);
            let entered!: () => void;
            let release!: () => void;
            const started = new Promise<void>(resolve => {
                entered = resolve;
            });
            const held = new Promise<void>(resolve => {
                release = resolve;
            });
            const mock = context.mock.method(page, "evaluate", async (...args: Parameters<Page["evaluate"]>) => {
                const clicked = await original(() => window.quantityFixture.clicks.refresh === 1);
                if (clicked) {
                    if (mode === "deadline") now = 60000;
                    entered();
                    await held;
                }
                return original(...args);
            });
            try {
                const pending = refreshTicketPlusTickets(page, session, control);
                await started;
                if (mode === "stop") controller.abort();
                else release();
                const result = await pending;
                assert.equal(result.stopReason, mode === "stop" ? "user-stop" : "time-limit");
                assert.equal(result.clickAttempted, true);
            } finally {
                release();
                mock.mock.restore();
            }
            assert.equal((await quantityState(page)).clicks.refresh, 1);
        });
    }
});
