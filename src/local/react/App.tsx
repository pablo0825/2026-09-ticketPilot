import { AppHeader } from "./shared/navigation/AppHeader.js";
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
    // 從平台首頁查看 TicketPlus 活動的執行狀態時，交給工作區開啟的活動 id。
    const [runActivityId, setRunActivityId] = useState<string>();

    function showPlatforms() {
        if (runs.closing) return;
        setMessage("");
        setRunActivityId(undefined);
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
                        setRunActivityId(undefined);
                        setPage("ticketplus");
                    }}
                    onViewRun={() => {
                        if (!platformStatus.kind) return;

                        // 對應到 TicketPlus 活動時，進入那個活動的執行狀態分頁；否則看獨立的狀態頁。
                        const activityId =
                            platformStatus.kind === "purchase" && runs.purchase?.platform === "ticketplus"
                                ? runs.purchase.activityId
                                : undefined;
                        if (activityId) {
                            setMessage("");
                            setRunActivityId(activityId);
                            setPage("ticketplus");
                            return;
                        }
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
                    openRunActivityId={runActivityId}
                    onRunActivityOpened={() => setRunActivityId(undefined)}
                    onPendingResolved={() => setPage("run")}
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
