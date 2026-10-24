import type { ComponentType } from "react";
import type { useRunStatus } from "../shared/runs/useRunStatus.js";

export interface WorkspaceProps {
    message: string;
    setMessage: (message: string) => void;
    runs: ReturnType<typeof useRunStatus>;
    onViewRun: () => void;
    onPendingResolved: () => void;
    registerLeaveGuard: (guard: () => boolean) => () => void;
    navigationBusy: boolean;
    managesPendingStart: boolean;
    onPendingChange: () => void;
}

export interface WorkspaceDefinition {
    id: string;
    name: string;
    Workspace: ComponentType<WorkspaceProps>;
}
