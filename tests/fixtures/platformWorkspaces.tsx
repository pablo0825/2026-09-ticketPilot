import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/gui/App.js";
import type { WorkspaceProps } from "../../src/gui/platforms/workspaceDefinition.js";
import { registeredWorkspaces } from "../../src/gui/platforms/workspaceRegistry.js";

function FixtureWorkspace({ runs, message, onViewRun, onHome, registerLeaveGuard }: WorkspaceProps) {
    useLayoutEffect(() => registerLeaveGuard(() => true), [registerLeaveGuard]);
    return (
        <section aria-label="假平台工作區">
            <h1>Fixture Platform Only</h1>
            <button onClick={onHome}>返回平台首頁</button>
            <div id="message">{message}</div>
            <p data-testid="run-id">{runs.purchase?.id ?? "none"}</p>
            <p data-testid="occupied">{String(runs.purchase?.occupied ?? false)}</p>
            <button onClick={onViewRun}>查看全域執行狀態</button>
        </section>
    );
}

const root = document.getElementById("root");
if (!root) throw new Error("測試 root 不存在");
createRoot(root).render(
    <App workspaces={[...registeredWorkspaces, { id: "fixture", name: "測試平台", Workspace: FixtureWorkspace }]} />,
);
