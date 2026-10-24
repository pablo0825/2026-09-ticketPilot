import type { WorkspaceDefinition } from "./workspaceDefinition.js";
import { TicketPlusWorkspace } from "./ticketplus/TicketPlusWorkspace.js";

// 狀態呈現另有入口；RunStatus 不引用工作區清單，避免元件循環載入。
export const registeredWorkspaces: readonly WorkspaceDefinition[] = [
    { id: "ticketplus", name: "TicketPlus", Workspace: TicketPlusWorkspace },
];
