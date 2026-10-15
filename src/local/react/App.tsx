import { AppHeader } from "./shared/AppHeader.js";
import { useState } from "react";
import { TicketPlusWorkspace } from "./platforms/ticketplus/TicketPlusWorkspace.js";
import { KlookWorkspace } from "./platforms/klook/KlookWorkspace.js";
import { PlatformHome } from "./pages/PlatformHome.js";
import { platformRunStatus } from "./shared/runs/runPresentation.js";
import { RunStatus } from "./shared/runs/RunStatus.js";
import { useRunStatus } from "./shared/runs/useRunStatus.js";

export function App() {
    // 全域狀態不隨平台工作區的切換而重建
    const [message, setMessage] = useState("");
    const [page, setPage] = useState<"platforms" | "klook" | "ticketplus" | "run">("platforms");
    const runs = useRunStatus(setMessage);
    const platformStatus = platformRunStatus(runs.purchase, runs.simulation);

    function showPlatforms() {
        if (runs.closing) return;
        setMessage("");
        setPage("platforms");
    }

    // 頁面只負責導覽，真正啟動仍經過平台與後端驗證
    return (
        <main>
            {page !== "klook" && page !== "ticketplus" && <AppHeader disabled={runs.closing} onHome={showPlatforms} />}
            {page !== "klook" && page !== "ticketplus" && (
                <div id="message" role="alert">
                    {message}
                </div>
            )}
            {page === "platforms" && (
                <PlatformHome
                    disabled={!runs.ready || runs.closing}
                    status={runs.ready ? platformStatus.label : "載入中…"}
                    canViewRun={platformStatus.kind !== null}
                    runPlatform={platformStatus.kind === "simulation" ? "klook" : (runs.purchase?.platform ?? null)}
                    onKlook={() => {
                        setMessage("");
                        setPage("klook");
                    }}
                    onTicketPlus={() => {
                        setMessage("");
                        setPage("ticketplus");
                    }}
                    onViewRun={() => {
                        if (!platformStatus.kind) return;
                        runs.showResult(platformStatus.kind);
                        setPage("run");
                    }}
                />
            )}
            {page === "klook" && (
                <KlookWorkspace message={message} setMessage={setMessage} runs={runs} onExit={showPlatforms} />
            )}
            {page === "ticketplus" && (
                <TicketPlusWorkspace
                    message={message}
                    setMessage={setMessage}
                    runs={runs}
                    onExit={showPlatforms}
                    onViewRun={() => {
                        runs.showCurrent();
                        setPage("run");
                    }}
                />
            )}
            {page === "run" && (
                <>
                    <RunStatus
                        displayed={runs.displayed}
                        loginHandoff={runs.loginHandoff}
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
