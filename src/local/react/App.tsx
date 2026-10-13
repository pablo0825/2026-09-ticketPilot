import { useState } from "react";
import { KlookWorkspace } from "./platforms/klook/KlookWorkspace.js";
import { useRunStatus } from "./shared/runs/useRunStatus.js";

export function App() {
    const [message, setMessage] = useState("");
    const runs = useRunStatus(setMessage);

    return (
        <main>
            <header>
                <div>
                    <small>本機購票助手</small>
                    <h1>TicketPilot</h1>
                </div>
            </header>
            <KlookWorkspace message={message} setMessage={setMessage} runs={runs} />
        </main>
    );
}
