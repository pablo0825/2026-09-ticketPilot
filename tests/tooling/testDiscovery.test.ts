import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, copyFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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

test("測試指令可省略分組並傳入 Node 選項，保留指定分組與錯字檢查", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "test-command-")));
    try {
        await mkdir(join(directory, "scripts"));
        await mkdir(join(directory, "tests/unit"), { recursive: true });
        for (const name of ["runTests.mjs", "testFiles.mjs"]) {
            await copyFile(new URL("../../scripts/" + name, import.meta.url), join(directory, "scripts", name));
        }
        await writeFile(join(directory, "tests/unit/example.test.ts"), "");

        // 清單模式不啟動整套測試，但會走真正的命令列解析與檔案選擇。
        const run = (...args: string[]) =>
            spawnSync(process.execPath, [join(directory, "scripts/runTests.mjs"), ...args, "--list"], {
                encoding: "utf8",
            });
        const expected = join(directory, "tests/unit/example.test.ts") + "\n";
        for (const args of [[], ["--test-reporter=tap"], ["--test-reporter", "tap"], ["unit", "--test-reporter=tap"]]) {
            const result = run(...args);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.stdout, expected);
        }
        const unknown = run("typo");
        assert.notEqual(unknown.status, 0);
        assert.match(unknown.stderr, /未知測試分組/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
