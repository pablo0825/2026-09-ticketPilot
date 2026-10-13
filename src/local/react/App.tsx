import { useState } from "react";
import { KlookWorkspace } from "./platforms/klook/KlookWorkspace.js";
import { PlatformHome } from "./pages/PlatformHome.js";
import { RunStatus } from "./shared/runs/RunStatus.js";
import { useRunStatus } from "./shared/runs/useRunStatus.js";

export function App() {
    // 全域狀態不隨平台工作區的切換而重建
    const [message, setMessage] = useState("");
    const [page, setPage] = useState<"platforms" | "klook" | "run">("platforms");
    const runs = useRunStatus(setMessage);
    const hasActiveRun = runs.purchase?.occupied === true || runs.simulation?.status === "running";

    function showPlatforms() {
        setMessage("");
        setPage("platforms");
    }

    // 頁面只負責導覽，真正啟動仍經過平台與後端驗證
    return (
        <main>
            <header>
                <div>
                    <small>本機購票助手</small>
                    <h1>TicketPilot</h1>
                </div>
            </header>
            {page !== "klook" && (
                <div id="message" role="alert">
                    {message}
                </div>
            )}
            {page === "platforms" && (
                <PlatformHome
                    disabled={!runs.ready || runs.closing}
                    hasActiveRun={hasActiveRun}
                    hasPurchaseResult={Boolean(runs.purchase)}
                    hasSimulationResult={Boolean(runs.simulation)}
                    onViewResult={kind => {
                        runs.showResult(kind);
                        setPage("run");
                    }}
                    onKlook={() => {
                        setMessage("");
                        setPage("klook");
                    }}
                    onViewRun={() => {
                        runs.showCurrent();
                        setPage("run");
                    }}
                />
            )}
            {page === "klook" && (
                <KlookWorkspace message={message} setMessage={setMessage} runs={runs} onExit={showPlatforms} />
            )}
            {page === "run" && (
                <>
                    <button
                        id="platformHomeButton"
                        className="secondary"
                        disabled={runs.closing}
                        onClick={showPlatforms}
                    >
                        返回平台首頁
                    </button>
                    <RunStatus
                        displayed={runs.displayed}
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
