import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api.js";
import "../style.css";

function Preview() {
    const [message, setMessage] = useState("正在確認本機連線…");
    useEffect(() => {
        let active = true;
        void api<{ activities: unknown[] }>("/api/activities").then(
            result => active && setMessage(`本機連線正常，已儲存 ${result.activities.length} 個活動。`),
            () => active && setMessage("無法連線本機服務。"),
        );
        return () => {
            active = false;
        };
    }, []);

    return (
        <main>
            <h1>TicketPilot</h1>
            <section className="card">
                <h2>React 介面預覽</h2>
                <p role="status">{message}</p>
                <a href="/">返回目前介面</a>
            </section>
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Preview />
    </StrictMode>,
);
