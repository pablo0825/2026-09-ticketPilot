import { AppHeader } from "./shared/navigation/AppHeader.js";
import { useState } from "react";
import { TicketPlusWorkspace } from "./platforms/ticketplus/TicketPlusWorkspace.js";
import { RunStatus } from "./shared/runs/RunStatus.js";
import { useRunStatus } from "./shared/runs/useRunStatus.js";

export function App() {
    // 全域狀態不隨活動列表與結果頁的切換而重建。
    const [message, setMessage] = useState("");
    const [page, setPage] = useState<"ticketplus" | "run">("ticketplus");
    const runs = useRunStatus(setMessage);

    function showActivities() {
        if (runs.closing) return;
        setMessage("");
        setPage("ticketplus");
    }

    // 頁面只負責導覽，真正啟動仍經過平台與後端驗證
    return (
        <main>
            {page === "ticketplus" && (
                <TicketPlusWorkspace
                    message={message}
                    setMessage={setMessage}
                    runs={runs}
                    onPendingResolved={() => setPage("run")}
                    onViewRun={() => {
                        runs.showCurrent();
                        setPage("run");
                    }}
                />
            )}
            {page === "run" && (
                <>
                    <AppHeader disabled={runs.closing} onHome={showActivities} />
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
