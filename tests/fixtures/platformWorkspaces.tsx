import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/local/react/App.js";
import type { WorkspaceProps } from "../../src/local/react/platforms/platformDefinition.js";
import { registeredWorkspaces } from "../../src/local/react/platforms/workspaceRegistry.js";

function FixtureWorkspace({ runs, message, onViewRun, registerLeaveGuard }: WorkspaceProps) {
    useLayoutEffect(() => registerLeaveGuard(() => true), [registerLeaveGuard]);
    return (
        <section aria-label="假平台工作區">
            <h1>Fixture Platform Only</h1>
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
