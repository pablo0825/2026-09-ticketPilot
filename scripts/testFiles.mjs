import { readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";

// 搬移期間保留原 test:gui 的範圍；完成搬移後也保留單元層的 GUI 保護。
const guiNames = new Set([
    "activityHome.test.ts",
    "runStatus.test.ts",
    "runParticipantsOrdering.test.ts",
    "runCloseOrdering.test.ts",
    "runEligibility.test.ts",
    "runPresenterRegistry.test.ts",
    "pendingStart.test.ts",
]);

export async function collectTestFiles(root) {
    const files = [];
    async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await visit(path);
            else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
        }
    }
    await visit(root);
    return files.sort();
}

export function selectTestFiles(files, root, group = "all") {
    const groups = ["all", "gui", "unit", "integration", "browser", "flow", "architecture", "tooling"];
    if (!groups.includes(group)) throw new Error(`未知測試分組：${group}`);
    const selected = files.filter(file => {
        if (group === "all") return true;
        const path = relative(root, file).split("\\").join("/");
        if (group !== "gui") return path.startsWith(group + "/");
        const name = basename(file);
        return (
            path.startsWith("browser/gui/") ||
            path.startsWith("flow/application/") ||
            path.startsWith("unit/gui/") ||
            name.includes("gui") ||
            name.startsWith("react") ||
            guiNames.has(name)
        );
    });
    if (selected.length === 0) throw new Error(`測試分組 ${group} 沒有找到任何測試。`);
    return selected;
}
