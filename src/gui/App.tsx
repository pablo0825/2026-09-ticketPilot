import { AppHeader } from "./shared/navigation/AppHeader.js";
import { useCallback, useRef, useState } from "react";
import { registeredWorkspaces } from "./platforms/workspaceRegistry.js";
import type { WorkspaceDefinition } from "./platforms/workspaceDefinition.js";
import { findPendingStart, hasPendingStart } from "./shared/runs/pendingStart.js";
import { RunStatus } from "./shared/runs/RunStatus.js";
import { useRunStatus } from "./shared/runs/useRunStatus.js";

interface Props {
    workspaces?: readonly WorkspaceDefinition[];
}

export function App({ workspaces = registeredWorkspaces }: Props) {
    const first = workspaces[0];
    if (!first || new Set(workspaces.map(item => item.id)).size !== workspaces.length) {
        throw new Error("平台工作區清單無效。");
    }
    // 全域狀態不隨活動列表與結果頁的切換而重建。
    const [message, setMessage] = useState("");
    const [page, setPage] = useState<"workspace" | "run">("workspace");
    const [platform, setPlatform] = useState(first.id);
    const [pending, setPending] = useState(hasPendingStart);
    const [checkingPending, setCheckingPending] = useState(false);
    const checkingPendingRef = useRef(false);
    const leaveGuard = useRef<(() => boolean) | null>(null);
    const registerLeaveGuard = useCallback((guard: () => boolean) => {
        leaveGuard.current = guard;
        return () => {
            if (leaveGuard.current === guard) leaveGuard.current = null;
        };
    }, []);
    const refreshPending = useCallback(() => setPending(hasPendingStart()), []);
    const runs = useRunStatus(setMessage);

    function showActivities() {
        if (runs.closing || checkingPendingRef.current) return;
        setMessage("");
        setPage("workspace");
    }

    const definition = workspaces.find(item => item.id === platform);
    if (!definition) throw new Error("找不到平台工作區。");
    const Workspace = definition.Workspace;
    const multiplePlatforms = workspaces.length > 1;

    function canLeaveWorkspace() {
        return page !== "workspace" || leaveGuard.current?.() === true;
    }

    function selectPlatform(id: string) {
        if (id === platform && page === "workspace") return;
        if (checkingPendingRef.current || runs.closing) return;
        // 每次操作重讀暫存；不能依賴較早 render 的值允許切換。
        if (hasPendingStart()) {
            setPending(true);
            setMessage("上一筆啟動結果尚待確認，請先查看待確認的啟動結果；暫時不能切換平台。");
            return;
        }
        if (!canLeaveWorkspace()) return;
        setMessage("");
        setPlatform(id);
        setPage("workspace");
    }

    async function inspectPending() {
        if (checkingPendingRef.current || runs.closing || !runs.ready || !canLeaveWorkspace()) return;
        checkingPendingRef.current = true;
        setCheckingPending(true);
        setMessage("");
        const previousId = runs.purchase?.id;
        try {
            const result = await findPendingStart();
            runs.showAccepted(result, previousId);
            setPage("run");
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
        } finally {
            checkingPendingRef.current = false;
            setCheckingPending(false);
            refreshPending();
        }
    }

    // 頁面只負責導覽，真正啟動仍經過平台與後端驗證
    return (
        <main>
            {multiplePlatforms && (
                <nav aria-label="平台選擇">
                    {workspaces.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            aria-pressed={platform === item.id}
                            disabled={runs.closing || checkingPending}
                            onClick={() => selectPlatform(item.id)}
                        >
                            {item.name}
                        </button>
                    ))}
                </nav>
            )}
            {multiplePlatforms && pending && (
                <section aria-label="待確認的啟動請求">
                    <p>有待確認的啟動請求。請先核對原流程，不會自動重新開始。</p>
                    <button
                        type="button"
                        disabled={checkingPending || runs.closing || !runs.ready}
                        onClick={() => void inspectPending()}
                    >
                        查看待確認的啟動結果
                    </button>
                </section>
            )}
            {page === "workspace" && (
                <Workspace
                    key={platform}
                    registerLeaveGuard={registerLeaveGuard}
                    navigationBusy={checkingPending}
                    managesPendingStart={multiplePlatforms}
                    onPendingChange={refreshPending}
                    message={message}
                    setMessage={setMessage}
                    runs={runs}
                    onPendingResolved={() => {
                        refreshPending();
                        setPage("run");
                    }}
                    onViewRun={() => {
                        if (checkingPendingRef.current) return;
                        runs.showCurrent();
                        setPage("run");
                    }}
                />
            )}
            {page === "run" && (
                <>
                    <AppHeader disabled={runs.closing || checkingPending} onHome={showActivities} />
                    <div id="message" role="alert">
                        {message}
                    </div>
                    <RunStatus
                        displayed={runs.displayed}

                        stopControl={runs.stopControl}
                        participantsControl={runs.participantsControl}
                        closing={runs.closing}
                        canClose={
                            runs.displayed?.kind === "purchase" &&
                            runs.displayed.run.id === runs.purchase?.id &&
                            Boolean(runs.purchase?.canCloseBrowser)
                        }
                        onClose={() => void runs.closeBrowser()}
                        onCopy={text =>
                            void navigator.clipboard.writeText(text).catch(error => setMessage(error.message))
                        }
                    />
                </>
            )}
        </main>
    );
}
