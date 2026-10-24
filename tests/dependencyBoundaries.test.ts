import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyViolations } from "./fixtures/dependencyGraph.js";

const root = new URL("../", import.meta.url);

test("frontend, contracts and execution rules keep their dependency boundaries", async () => {
    const entries = await readdir(new URL("src/", root), { recursive: true, withFileTypes: true });
    const files: Record<string, string> = {};
    for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:tsx?|css)$/.test(entry.name)) continue;
        const absolute = join(entry.parentPath, entry.name);
        const name = relative(fileURLToPath(root), absolute).replaceAll("\\", "/");
        files[name] = await readFile(absolute, "utf8");
    }
    // 規則只檢查實際讀到的檔案；資料夾改名或搬走時要明確失敗，不能在空清單上通過。
    for (const layer of ["src/gui/", "src/shared/", "src/server/"]) {
        assert(
            Object.keys(files).some(name => name.startsWith(layer)),
            `沒有讀到 ${layer} 的檔案`,
        );
    }
    assert.deepEqual(dependencyViolations(files), []);
});

test("dependency parser accepts frontend packages, CSS, type contracts and worker URL references", () => {
    assert.deepEqual(
        dependencyViolations({
            "src/gui/view.tsx":
                'import {Fragment} from "react"; import type {X} from "../shared/data.js"; import "./style.css"; export const view = <Fragment />;',
            "src/gui/style.css": "",
            "src/shared/data.ts": 'export type {X} from "../config/data.js";',
            "src/config/data.ts": 'import {z} from "zod"; export type X = string;',
            "src/server/server.ts":
                'const worker = new URL("../workers/worker.ts", import.meta.url); const text = "import(\'playwright\')"; // import("playwright")',
            "src/workers/worker.ts": 'import { chromium } from "playwright";',
        }),
        [],
    );
});

test("dependency parser rejects forbidden static, type, re-export and delayed imports", () => {
    const expressions = [
        'import type {X} from "../server/data.js";',
        'import {type X} from "../server/data.js";',
        'export type {X} from "../server/data.js";',
        'export * from "../server/data.js";',
        'type X = import("../server/data.js").X;',
        'async function load(){return import("../server/data.js")}',
        "async function load(){return import(`../server/data.js`)}",
        'const data = require("../server/data.js");',
        'import data = require("../server/data.js");',
    ];
    for (const expression of expressions) {
        const errors = dependencyViolations({
            "src/gui/view.ts": expression,
            "src/server/data.ts": "export type X = string;",
        });
        assert.equal(errors.length, 1, expression);
        assert.match(errors[0] ?? "", /forbidden dependency layer/, expression);
    }
});

test("browser-safe layers reject builtins, unknown packages and unresolved dynamic imports", () => {
    for (const specifier of ["node:fs", "fs", "fs/promises", "playwright", "unreviewed-package"]) {
        const errors = dependencyViolations({
            "src/core/example.ts": `import value from ${JSON.stringify(specifier)};`,
        });
        assert.equal(errors.length, 1, specifier);
    }
    for (const expression of ["import(path)", "import(`./${name}.js`)", "require(path)"]) {
        const errors = dependencyViolations({
            "src/gui/view.ts": `function load(path: string, name: string) { return ${expression}; }`,
        });
        assert.match(errors[0] ?? "", /must be a string literal/);
    }
});

test("indirect frontend dependencies and missing local modules cannot escape checking", () => {
    const errors = dependencyViolations({
        "src/gui/view.ts": 'import "../config/bridge.js";',
        "src/config/bridge.ts": 'export * from "../server/data.js";',
        "src/server/data.ts": "export const value = 1;",
        "src/shared/missing.ts": 'import "./absent.js";',
    });
    assert.equal(errors.length, 2);
    assert.ok(errors.some(error => error.includes("src/config/bridge.ts")));
    assert.ok(errors.some(error => error.includes("local module does not exist")));
});

test("server traversal catches deferred Playwright imports and unknown module paths", () => {
    for (const expression of [
        'import("playwright")',
        'import("playwright-core/lib/server")',
        'require("@playwright/test")',
        "import(modulePath)",
    ]) {
        const errors = dependencyViolations({
            "src/server/server.ts": 'export * from "../storage/helper.js";',
            "src/storage/helper.ts": `export function later(modulePath: string) { return ${expression}; }`,
        });
        assert.equal(errors.length, 1, expression);
        assert.match(errors[0] ?? "", /src\/storage\/helper.ts/);
    }
});
