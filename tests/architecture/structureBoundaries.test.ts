import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("../fixtures/structureProbe.ts", import.meta.url));
const loader = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

for (const mode of ["server-import", "paths", "default-paths", "default-worker", "main"]) {
    test(`結構保護：${mode} 在隔離工作目錄可執行`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "ticket-structure-"));
        try {
            const selectedProbe =
                mode === "default-paths"
                    ? fileURLToPath(new URL("../fixtures/defaultPathsProbe.ts", import.meta.url))
                    : probe;
            const result = spawnSync(process.execPath, ["--import", loader, selectedProbe, mode, directory], {
                cwd: directory,
                encoding: "utf8",
                timeout: 30_000,
            });
            assert.equal(result.error, undefined);
            assert.equal(result.status, 0, result.stderr || result.stdout);
            if (mode === "main") {
                assert.match(result.stdout, /isolated-service-started/);
                assert.match(result.stdout, /isolated-service-closed/);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
}
