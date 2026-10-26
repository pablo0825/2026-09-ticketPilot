import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 工具是原生 JavaScript，與 node:test 的啟動環境一致。
const { collectTestFiles, selectTestFiles } = await import("../../scripts/testFiles.mjs");

test("測試搜尋涵蓋頂層與多層目錄，不收 fixture、不重複，空分組與未知分組失敗", async () => {
    const root = await mkdtemp(join(tmpdir(), "test-discovery-"));
    try {
        const names = ["root.test.ts", "unit/rule.test.ts", "browser/ticketplus/page.test.ts", "fixtures/page.ts"];
        for (const name of names) {
            const path = join(root, name);
            await mkdir(join(path, ".."), { recursive: true });
            await writeFile(path, "");
        }
        const files = await collectTestFiles(root);
        assert.deepEqual(
            files,
            names
                .slice(0, 3)
                .map(name => join(root, name))
                .sort(),
        );
        assert.deepEqual(selectTestFiles(files, root), files);
        assert.deepEqual(selectTestFiles(files, root, "browser"), [join(root, names[2]!)]);
        assert.throws(() => selectTestFiles(files, root, "flow"), /沒有找到/);
        assert.throws(() => selectTestFiles(files, root, "typo"), /未知/);
        assert.throws(() => selectTestFiles([], root), /沒有找到/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
