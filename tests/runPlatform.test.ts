import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { acquirePurchaseLease, releasePurchaseLease } from "../src/app/purchaseLock.js";

// 手寫既有 v4 正規化內容與順序，不透過本次 parser 產生歷史指紋。
const activity = {
    platform: "klook",
    eventUrl: "https://www.klook.com/zh-TW/event-detail/fixture/",
    eventName: "平台紀錄測試",
    fallbackMode: "STRICT",
    excludeKeywords: [],
    targets: [{ date: "2026-11-21", time: "19:30", area: "B區", quantity: 1, adjacent: false }],
};
const contact = {
    firstName: "Demo",
    lastName: "Test",
    regionLabel: "台灣 (+886)",
    phone: "0912345678",
    email: "fixture@example.com",
};
const worker = new URL("./fixtures/countedPurchaseWorker.ts", import.meta.url);

function historicalRecord(requestId: string, version: number | undefined) {
    return {
        ...(version === undefined ? {} : { fingerprintVersion: version }),
        fingerprint: createHash("sha256").update(JSON.stringify({ activity, contact })).digest("hex"),
        snapshot: {
            id: `1-${requestId}`,
            requestId,
            activityName: activity.eventName,
            status: "unknown",
            browserOpen: false,
            occupied: false,
            message: "提交結果不明",
            historyTruncated: false,
            events: [{ sequence: 1, at: "2026-10-01T00:00:00.000Z", event: { type: "log", message: "舊紀錄" } }],
        },
    };
}

for (const version of [undefined, 2, 3, 4]) {
    test(`既有 ${version ?? "無版本"} 紀錄補 Klook，不改指紋或重啟購票`, async () => {
        const dir = await mkdtemp(join(tmpdir(), "ticket-run-platform-"));
        let runs: PurchaseRuns | undefined;
        try {
            // 寫入缺少平台的真實歷史形狀
            const id = randomUUID();
            const record = historicalRecord(id, version);
            const raw = JSON.stringify(record);
            await mkdir(join(dir, "runs"));
            const path = join(dir, "runs", `${id}.json`);
            await writeFile(path, raw);
            runs = new PurchaseRuns(dir, worker);

            // 讀取只補顯示資訊，不改寫舊檔或事件
            assert.equal(runs.snapshot()?.platform, "klook");
            assert.equal(runs.snapshot()?.status, "unknown");
            assert.deepEqual(runs.snapshot()?.events, record.snapshot.events);
            assert.equal(await readFile(path, "utf8"), raw);
            if (version === 4) {
                assert.equal(runs.start(id, activity, contact).id, record.snapshot.id);
                assert.throws(() => runs!.start(id, { ...activity, eventName: "不同活動" }, contact), /更換設定/);
            } else {
                assert.throws(() => runs!.start(id, activity, contact), /舊版開始請求/);
            }

            // 重播歷史請求不能啟動 worker 或增加紀錄
            assert.equal(runs.busy(), false);
            assert.deepEqual(await readdir(join(dir, "runs")), [`${id}.json`]);
            await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
        } finally {
            runs?.close();
            await rm(dir, { recursive: true, force: true });
        }
    });
}

test("明確平台保留，未知平台或損壞紀錄不能猜成 Klook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-platform-invalid-"));
    try {
        // 新格式保留明確平台，不啟動任何流程
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const path = join(dir, "runs", `${id}.json`);
        const record = historicalRecord(id, 4);
        for (const platform of ["klook", "ticketplus"]) {
            await writeFile(path, JSON.stringify({ ...record, snapshot: { ...record.snapshot, platform } }));
            const runs = new PurchaseRuns(dir, worker);
            assert.equal(runs.snapshot()?.platform, platform);
            if (platform === "ticketplus") {
                assert.throws(() => runs.start(id, activity, contact), /不能更換平台/);
            }
            runs.close();
        }

        // 有寫平台但值無效時，不適用舊格式預設
        for (const platform of ["unknown", null, 123]) {
            const raw = JSON.stringify({ ...record, snapshot: { ...record.snapshot, platform } });
            await writeFile(path, raw);
            assert.throws(() => new PurchaseRuns(dir, worker), /執行紀錄無法讀取/);
            assert.equal(await readFile(path, "utf8"), raw);
        }
        await writeFile(path, "{broken");
        assert.throws(() => new PurchaseRuns(dir, worker), /執行紀錄無法讀取/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("新執行紀錄保存平台；外部占用維持未知且阻擋啟動", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-platform-current-"));
    const runs = new PurchaseRuns(dir, worker);
    try {
        // 外部占用無法得知平台，不能任意標示 Klook
        const lease = acquirePurchaseLease(dir);
        try {
            assert.equal(runs.snapshot()?.platform, null);
            assert.equal(runs.snapshot()?.occupied, true);
            assert.throws(() => runs.start(randomUUID(), activity, contact), /占用/);
            assert.deepEqual(await readdir(join(dir, "runs")), []);
        } finally {
            releasePurchaseLease(lease);
        }

        // 新紀錄立即包含平台，子程序僅使用本機計數 fixture
        const id = randomUUID();
        assert.equal(runs.start(id, activity, contact).platform, "klook");
        const saved = JSON.parse(await readFile(join(dir, "runs", `${id}.json`), "utf8"));
        assert.equal(saved.snapshot.platform, "klook");
        assert.equal(saved.fingerprintVersion, 4);
        assert.equal(saved.fingerprint, historicalRecord(id, 4).fingerprint);
        for (let i = 0; i < 100 && runs.busy(); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(runs.busy(), false);
    } finally {
        runs.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("重啟只把舊 running 紀錄標成中斷並補平台，不改指紋與重送結果", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-platform-interrupted-"));
    let runs: PurchaseRuns | undefined;
    try {
        // 模擬服務中斷前留下的舊格式
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const record = historicalRecord(id, 4);
        record.snapshot.status = "running";
        const path = join(dir, "runs", `${id}.json`);
        await writeFile(path, JSON.stringify(record));

        // 重啟保留原請求與事件，只更新中斷狀態和平台資訊
        runs = new PurchaseRuns(dir, worker);
        const saved = JSON.parse(await readFile(path, "utf8"));
        assert.equal(saved.snapshot.platform, "klook");
        assert.equal(saved.snapshot.status, "interrupted");
        assert.equal(saved.fingerprint, record.fingerprint);
        assert.deepEqual(saved.snapshot.events, record.snapshot.events);
        assert.equal(runs.start(id, activity, contact).status, "interrupted");
        assert.equal(runs.busy(), false);
        await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test("歷史紀錄加全域占用仍保留原結果，不猜測占用來源或清除占用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-platform-external-"));
    let runs: PurchaseRuns | undefined;
    try {
        // 保留一筆歷史結果，再由其他程序取得占用
        await mkdir(join(dir, "runs"));
        const id = randomUUID();
        const record = historicalRecord(id, 4);
        await writeFile(join(dir, "runs", `${id}.json`), JSON.stringify(record));
        runs = new PurchaseRuns(dir, worker);
        const lease = acquirePurchaseLease(dir);
        try {
            // 平台描述原紀錄，全域占用不代表已確認鎖的來源
            assert.equal(runs.snapshot()?.platform, "klook");
            assert.equal(runs.snapshot()?.id, record.snapshot.id);
            assert.equal(runs.snapshot()?.occupied, true);
            assert.throws(() => runs!.start(randomUUID(), activity, contact), /占用/);

            // 原請求仍取得原本的結果，不能回傳外部占用的空 ID
            const replay = runs.start(id, activity, contact);
            assert.equal(replay.id, record.snapshot.id);
            assert.equal(replay.platform, "klook");
            assert.equal(replay.status, "unknown");
            assert.equal(replay.occupied, true);
            assert.equal(runs.busy(), true);
            await assert.rejects(readFile(join(dir, "worker-starts.txt")), { code: "ENOENT" });
        } finally {
            releasePurchaseLease(lease);
        }
        assert.equal(runs.snapshot()?.id, record.snapshot.id);
        assert.equal(runs.snapshot()?.platform, "klook");
    } finally {
        runs?.close();
        await rm(dir, { recursive: true, force: true });
    }
});
