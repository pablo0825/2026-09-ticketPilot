import { PlatformHome } from "./pages/PlatformHome.js";
import { Breadcrumbs } from "./shared/navigation/Breadcrumbs.js";
import { purchaseStatus } from "./shared/runs/runPresentation.js";
import { secondaryButton } from "./shared/styles.js";
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
    const [page, setPage] = useState<"home" | "workspace" | "run">("home");
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

    function showHome() {
        if (runs.closing || checkingPendingRef.current || !canLeaveWorkspace()) return;
        refreshPending();
        setMessage("");
        setPage("home");
    }

    function showCurrentRun() {
        if (runs.closing || checkingPendingRef.current || !canLeaveWorkspace()) return;
        runs.showCurrent();
        setPage("run");
    }

    const definition = workspaces.find(item => item.id === platform);
    if (!definition) throw new Error("找不到平台工作區。");
    const Workspace = definition.Workspace;

    function canLeaveWorkspace() {
        return page !== "workspace" || leaveGuard.current?.() === true;
    }

    function selectPlatform(id: string) {
        if (id === platform && page === "workspace") return;
        if (checkingPendingRef.current || runs.closing || !runs.ready) return;
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
            {page !== "workspace" && (
                <>
                    <AppHeader disabled={runs.closing || checkingPending} onHome={showHome} />
                    <div
                        id="message"
                        role="alert"
                        data-tailwind
                        className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 empty:hidden"
                    >
                        {message}
                    </div>
                </>
            )}
            {page !== "workspace" && pending && (
                <section
                    data-tailwind
                    aria-label="待確認的啟動請求"
                    className="mb-4 space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4"
                >
                    <p>有待確認的啟動請求。請先核對原流程，不會自動重新開始。</p>
                    <button
                        type="button"
                        className={secondaryButton}
                        disabled={checkingPending || runs.closing || !runs.ready}
                        onClick={() => void inspectPending()}
                    >
                        查看待確認的啟動結果
                    </button>
                </section>
            )}
            {page === "home" && (
                <PlatformHome
                    disabled={!runs.ready || runs.closing || checkingPending}
                    entryBlocked={pending}
                    platforms={workspaces.map(item => ({
                        id: item.id,
                        name: item.name,
                        status: !runs.ready
                            ? "載入中…"
                            : runs.purchase?.platform === item.id
                              ? purchaseStatus(runs.purchase, runs.closing, Date.now()).title
                              : "可進入設定",
                        onEnter: () => selectPlatform(item.id),
                        onViewRun: runs.purchase?.platform === item.id ? showCurrentRun : undefined,
                    }))}
                    unknownRun={
                        runs.purchase && !workspaces.some(item => item.id === runs.purchase?.platform)
                            ? {
                                  status: purchaseStatus(runs.purchase, runs.closing, Date.now()).title,
                                  onView: showCurrentRun,
                              }
                            : undefined
                    }
                />
            )}
            {page === "workspace" && (
                <Workspace
                    key={platform}
                    registerLeaveGuard={registerLeaveGuard}
                    navigationBusy={checkingPending}
                    managesPendingStart={false}
                    onHome={showHome}
                    onPendingChange={refreshPending}
                    message={message}
                    setMessage={setMessage}
                    runs={runs}
                    onPendingResolved={() => {
                        refreshPending();
                        setPage("run");
                    }}
                    onViewRun={showCurrentRun}
                />
            )}
            {page === "run" && (
                <>
                    <Breadcrumbs
                        items={[
                            { label: "首頁", actionLabel: "返回平台首頁", onSelect: showHome },
                            { label: "執行結果" },
                        ]}
                        disabled={runs.closing || checkingPending}
                    />
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
