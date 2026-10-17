import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { diagnoseReadFailure } from "../src/platforms/ticketplus/readFailure.js";
import { readTicketPlusActivityObservation, readTicketPlusPage } from "../src/platforms/ticketplus/pageState.js";
import type { TicketPlusPageDiagnostic } from "../src/platforms/ticketplus/pageState.js";
import type { TicketPlusDom } from "../src/platforms/ticketplus/domSnapshot.js";

const url = "https://ticketplus.com.tw/activity/event-fixture";
const target = { eventId: "event-fixture", eventName: "測試活動" };
const secret = "private@example.com?token=do-not-log";

function mockPage(overrides: Record<string, unknown> = {}): Page {
    return { url: () => url, isClosed: () => false, ...overrides } as unknown as Page;
}

function emptyDom(): TicketPlusDom {
    return {
        origin: "https://ticketplus.com.tw",
        pathname: "/activity/event-fixture",
        extraUrlParts: false,
        queueCount: 0,
        dialogs: [],
        activity: [],
        identities: [],
        tickets: [],
        areas: [],
        information: { contact: [[], [], []], terms: [], headingCount: 0 },
        checkout: [],
        activityNames: [],
        nextButtons: [],
        refreshButtons: [],
        refreshEvidence: undefined,
        paymentButtons: [],
        checkoutStepCount: 0,
    };
}

test("讀取失敗分類：僅明確錯誤分類，原始訊息與網址不外洩", () => {
    const cases = [
        ["Execution context was destroyed, most likely because of a navigation.", false, "navigation-interrupted"],
        ["Cannot find context with specified id", false, "other-read-error"],
        ["Target page, context or browser has been closed", false, "target-closed"],
        ["Target closed", false, "target-closed"],
        ["Execution context was destroyed", true, "page-closed"],
        ["navigation timeout", false, "other-read-error"],
    ] as const;
    for (const [message, closed, category] of cases) {
        const diagnostic = diagnoseReadFailure(
            new Error(`${message} ${secret}`),
            mockPage({ isClosed: () => closed }),
            "capture-dom",
            `${url}?${secret}`,
            `${url}?${secret}`,
        );
        assert.equal(diagnostic.category, category);
        assert.equal(diagnostic.pageClosed, closed);
        assert.equal(diagnostic.urlChanged, false);
        assert.equal(diagnostic.routeBefore, "activity");
        assert.equal(diagnostic.routeAfter, "activity");
        assert(!JSON.stringify(diagnostic).includes(secret));
    }
    const changed = diagnoseReadFailure(
        new Error("unknown"),
        mockPage(),
        "capture-dom",
        url,
        "https://ticketplus.com.tw/order/event-fixture/session-A",
    );
    assert.equal(changed.urlChanged, true);
    assert.equal(changed.routeAfter, "order");
});

test("讀取失敗分類：無法讀取錯誤、關頁狀態與網址仍安全回傳未知", () => {
    const error = Object.defineProperty(new Error(), "message", {
        get() {
            throw new Error(secret);
        },
    });
    const page = mockPage({
        isClosed() {
            throw new Error(secret);
        },
        url() {
            throw new Error(secret);
        },
    });
    assert.deepEqual(diagnoseReadFailure(error, page, "read-url-before", undefined, undefined), {
        step: "read-url-before",
        category: "other-read-error",
        pageClosed: null,
        routeBefore: null,
        routeAfter: null,
        urlChanged: null,
    });
    assert.equal(diagnoseReadFailure(secret, mockPage(), "capture-dom", url, url).category, "other-read-error");
    for (const message of [
        Symbol("private"),
        {
            toString() {
                throw new Error(secret);
            },
        },
    ]) {
        const malformed = Object.defineProperty(new Error(), "message", { value: message });
        assert.equal(diagnoseReadFailure(malformed, mockPage(), "capture-dom", url, url).category, "other-read-error");
    }
});

test("讀取失敗步驟：網址讀取、DOM擷取與網址驗證仍回傳既有 unknown 結果", async () => {
    for (const step of ["read-url-before", "capture-dom", "read-url-after", "validate-url", "classify-page"] as const) {
        let reads = 0;
        let captures = 0;
        const page = mockPage({
            url() {
                reads++;
                if (step === "read-url-before" || (step === "read-url-after" && reads === 2)) throw new Error(secret);
                return step === "validate-url" ? "invalid-url" : url;
            },
            async evaluate() {
                captures++;
                if (step === "capture-dom") throw new Error(`Execution context was destroyed ${secret}`);
                const dom = emptyDom();
                if (step === "classify-page")
                    Object.defineProperty(dom, "extraUrlParts", {
                        get() {
                            throw new Error(secret);
                        },
                    });
                return dom;
            },
        });
        let diagnostic: TicketPlusPageDiagnostic | undefined;
        const result = await readTicketPlusPage(page, value => {
            diagnostic = value;
        });
        assert.equal(result.kind, "unknown");
        if (result.kind === "unknown") assert.equal(result.reason, "read-failed");
        assert.equal(diagnostic?.readFailure?.step, step);
        assert.equal(captures, step === "read-url-before" ? 0 : 1);
        assert(!JSON.stringify(diagnostic).includes(secret));
    }
});

test("讀取失敗診斷：callback 拋錯不改變點擊前 stop 決策且不重讀 DOM", async () => {
    let reads = 0;
    const page = mockPage({
        async evaluate() {
            reads++;
            throw new Error("Execution context was destroyed");
        },
    });
    const withoutCallback = await readTicketPlusActivityObservation(page, target);
    const withCallback = await readTicketPlusActivityObservation(page, target, () => {
        throw new Error(secret);
    });
    assert.deepEqual(withCallback, withoutCallback);
    assert.deepEqual(withCallback.readiness, { status: "stop", reason: "read-failed" });
    assert.equal(reads, 2);
});
