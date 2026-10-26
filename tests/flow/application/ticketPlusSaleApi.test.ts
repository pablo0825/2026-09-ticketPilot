import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { apiHarness, apiActivity } from "../../fixtures/ticketplus/apiHarness.js";

const zeroCounts = { session: 0, plus: 0, submit: 0, dismiss: 0, information: 0, other: 0, terms: 0 };
type Harness = Awaited<ReturnType<typeof apiHarness>>;

async function scheduledLogin(h: Harness, seconds = 7) {
    // 儲存並啟動真正 worker，再人工交接；時間輸入獨立由測試建立。
    const saleTime = Math.ceil(Date.now() / 1000) * 1000 + seconds * 1000;
    const saleAt = new Date(saleTime + 8 * 3600_000).toISOString().slice(0, 19) + "+08:00";
    const settings = { ...apiActivity, saleSchedule: { saleAt }, maxRunMinutes: 10 };
    const saved = await (await h.request("/api/activities", settings)).json();
    const requestId = randomUUID();
    const body = { requestId, activityId: saved.id, expectedActivity: settings };
    const response = await h.request("/api/purchase", body);
    assert.equal(response.status, 200);
    const run = await response.json();
    const login = await h.until(value =>
        Boolean(
            value?.events.some(item => item.event.type === "ticketplus" && item.event.stage === "waiting-for-login"),
        ),
    );
    await h.login();
    return { saleAt, saleTime, run, body };
}

test(
    "開賣 API：時間到之前零操作，到點走正式 worker 且預設提前一秒刷新、不重建同請求",
    { timeout: 20_000 },
    async () => {
        const h = await apiHarness();
        try {
            const { saleTime, run, body } = await scheduledLogin(h);
            await h.until(
                value =>
                    value?.events.some(
                        event => event.event.type === "ticketplus" && event.event.stage === "waiting-for-sale",
                    ) === true,
            );
            assert(Date.now() < saleTime, "必須真的進入未到時的等待，不可直接略過");
            assert.deepEqual((await h.counts()).counts, zeroCounts);
            const remaining = saleTime - Date.now();
            if (remaining > 300) await new Promise(resolve => setTimeout(resolve, remaining - 200));
            assert.deepEqual((await h.counts()).counts, zeroCounts);
            const completed = await h.until(value => value?.status === "payment-ready");
            assert(Date.now() >= saleTime);
            assert.equal(completed.id, run.id);
            const report = await h.counts();
            assert.deepEqual(report.counts, { ...zeroCounts, session: 1, plus: 2, submit: 1, information: 1 });
            assert.equal(report.requests.filter((path: string) => path.startsWith("/activity/")).length, 2);
            const activityLoads = report.timeline.filter((entry: { kind: string }) =>
                entry.kind.startsWith("/activity/"),
            );
            assert(activityLoads[1].at >= saleTime - 1000, "預設提前一秒，不能更早送刷新請求");
            assert(activityLoads[1].at < saleTime, "必須觀察到開賣前的刷新請求");
            const sessionClick = report.timeline.find((entry: { kind: string }) => entry.kind === "session");
            const submitClick = report.timeline.find((entry: { kind: string }) => entry.kind === "submit");
            assert(sessionClick.at >= saleTime, "不能看到可按就提前選場次");
            assert(submitClick.at >= sessionClick.at, "提交必須在核對場次之後");
            const replay = await h.request("/api/purchase", body);
            assert.equal(replay.status, 200);
            assert.equal((await replay.json()).id, run.id);
            assert.deepEqual((await h.counts()).counts, report.counts);
        } finally {
            await h.dispose();
        }
    },
);

test("開賣 API：等待中停止，跨過原開賣時間仍沒有選票或提交", { timeout: 20_000 }, async () => {
    const h = await apiHarness();
    try {
        const { saleTime, run } = await scheduledLogin(h);
        await h.until(
            value =>
                value?.events.some(
                    event => event.event.type === "ticketplus" && event.event.stage === "waiting-for-sale",
                ) === true,
        );
        assert(Date.now() < saleTime);
        assert.equal((await h.request("/api/purchase/stop", { runId: run.id })).status, 200);
        const stopped = await h.until(value => value?.status === "failed");
        assert.match(stopped.message, /停止/);
        assert.equal(stopped.canCloseBrowser, true);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, saleTime - Date.now()) + 300));
        assert.deepEqual((await h.counts()).counts, zeroCounts);
        assert.deepEqual((await h.counts()).requests, ["/", "/activity/event-fixture"]);
    } finally {
        await h.dispose();
    }
});

test("開賣 API：等待中關閉購票頁會結束，不等遠期開賣也不操作", { timeout: 20_000 }, async () => {
    const h = await apiHarness();
    try {
        await scheduledLogin(h, 3600);
        await h.until(
            value =>
                value?.events.some(
                    event => event.event.type === "ticketplus" && event.event.stage === "waiting-for-sale",
                ) === true,
        );
        await h.closePage();
        const stopped = await h.until(value => value?.status !== "running");
        assert.equal(stopped.status, "failed");
        assert.deepEqual((await h.counts()).counts, zeroCounts);
    } finally {
        await h.dispose();
    }
});
