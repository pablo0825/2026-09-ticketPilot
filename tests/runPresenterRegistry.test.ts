import assert from "node:assert/strict";
import { test } from "node:test";
import { createPresenterRegistry } from "../src/local/react/platforms/runPresenterDefinition.js";
import { ticketPlusPresenter } from "../src/local/react/platforms/ticketplus/runPresentation.js";
import { presenterFor, platformEventMessage } from "../src/local/react/platforms/runPresenterRegistry.js";
import { purchaseStatus } from "../src/local/react/shared/runs/runPresentation.js";
import type { PurchaseSnapshot } from "../src/shared/runSnapshot.js";
import type { PurchaseEvent } from "../src/shared/runEvents.js";

const snapshot: PurchaseSnapshot = {
    platform: null,
    id: "fixture",
    requestId: "fixture",
    activityName: "fixture",
    status: "running",
    browserOpen: false,
    occupied: true,
    message: "",
    events: [],
    historyTruncated: false,
};
test("平台呈現分派不同步驟與事件；未知平台保留共用提示", () => {
    type Event = PurchaseEvent | { type: "fixture"; phase: string };
    const lookup = createPresenterRegistry<Event>([
        {
            ...ticketPlusPresenter,
            eventMessage: event => (event.type === "ticketplus" ? `TicketPlus 階段：${event.stage}` : undefined),
        },
        {
            id: "fixture",
            name: "Fixture",
            status: () => ({ title: "檢查資格", instruction: "等待核對" }),
            steps: () => ({
                title: "檢查資格",
                summary: "等待核對",
                badge: { text: "檢查中", tone: "info" },
                steps: [{ label: "資格", state: "running" }],
            }),
            eventMessage: event => (event.type === "fixture" ? event.phase : undefined),
        },
    ]);
    assert.equal(lookup("fixture")?.status(snapshot, false, 0).title, "檢查資格");
    assert.equal(lookup("fixture")?.steps?.(snapshot, false, 0)?.steps[0]?.label, "資格");
    assert.equal(lookup("fixture")?.eventMessage({ type: "ticketplus", stage: "starting" }), undefined);
    assert.equal(lookup("ticketplus")?.eventMessage({ type: "fixture", phase: "check" }), undefined);
    assert.equal(presenterFor("fixture"), undefined);
    assert.equal(platformEventMessage({ type: "ticketplus", stage: "starting" }, null), undefined);
    assert.equal(purchaseStatus(snapshot, false, 0).title, "正在購票");
});
