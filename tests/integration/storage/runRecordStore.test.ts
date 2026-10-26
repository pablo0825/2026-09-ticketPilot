import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRunRecord } from "../../../src/server/runs/runRecord.js";
import { RunRecordStore } from "../../../src/server/runs/runRecordStore.js";
import { historicalRecord } from "../../fixtures/runRecords.js";

function ticketPlusRecord(requestId: string) {
    const record = parseRunRecord(historicalRecord(requestId, "ticketplus"), requestId);
    assert(record !== "archived-klook");
    return record;
}

test("執行紀錄只建立一次；同一請求再建立時原樣丟出檔案錯誤，原檔不變", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-store-create-"));
    try {
        const store = new RunRecordStore(dir);
        const id = randomUUID();
        const record = ticketPlusRecord(id);
        store.create(record);
        const path = join(dir, "runs", `${id}.json`);
        const raw = await readFile(path, "utf8");
        assert.equal((await stat(path)).mode & 0o777, 0o600);

        // 去重依賴建立失敗；保留原始錯誤，呼叫端與回應訊息才不會改變。
        const changed = { ...record, snapshot: { ...record.snapshot, message: "第二次" } };
        assert.throws(() => store.create(changed), { code: "EEXIST" });
        assert.equal(await readFile(path, "utf8"), raw);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("覆寫執行紀錄後不留下暫存檔，權限維持只限本人", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-store-replace-"));
    try {
        const store = new RunRecordStore(dir);
        const id = randomUUID();
        const record = ticketPlusRecord(id);
        store.create(record);
        store.replace({ ...record, snapshot: { ...record.snapshot, message: "已更新" } });

        const path = join(dir, "runs", `${id}.json`);
        assert.equal(JSON.parse(await readFile(path, "utf8")).snapshot.message, "已更新");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual(await readdir(join(dir, "runs")), [`${id}.json`]);
        assert.deepEqual(store.loadAll(), [store.read(id)]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("無效識別碼：查詢丟出錯誤，讀取回報無法讀取，不存在的紀錄回傳 undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-run-store-id-"));
    try {
        const store = new RunRecordStore(dir);
        // 查詢不能回傳 false；呼叫端要把無法確認視為已接受。
        assert.throws(() => store.exists("not-a-uuid"), { message: "開始請求識別碼無效。" });
        assert.throws(() => store.read("not-a-uuid"), { message: "執行紀錄無法讀取，請先人工檢查。" });
        assert.equal(store.exists(randomUUID()), false);
        assert.equal(store.read(randomUUID()), undefined);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
