import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectTestFiles, selectTestFiles } from "./testFiles.mjs";

const root = fileURLToPath(new URL("../tests/", import.meta.url));
const args = process.argv.slice(2);
const list = args.includes("--list");
const positional = args.filter(arg => arg !== "--list");
const group = positional.shift() ?? "all";
const files = selectTestFiles(await collectTestFiles(root), root, group);
if (list) {
    for (const file of files) console.log(file);
} else {
    const child = spawn(
        process.execPath,
        ["--import", "tsx", "--test", "--test-concurrency=4", ...positional, ...files],
        {
            cwd: fileURLToPath(new URL("../", import.meta.url)),
            stdio: "inherit",
        },
    );
    child.on("error", error => {
        console.error(error);
        process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
        process.exitCode = code ?? (signal ? 1 : 0);
    });
}
