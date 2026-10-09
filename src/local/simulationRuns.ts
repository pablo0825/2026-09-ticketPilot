import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseActivity, projectRoot } from "../config/activityStore.js";
import { validateContactDetails } from "../config/contact.config.js";
import type { RunEvent } from "../core/logger.js";

export interface SimulationSnapshot {
    id: string;
    status: "running" | "completed" | "interrupted";
    events: { sequence: number; at: string; event: RunEvent }[];
    historyTruncated: boolean;
}
interface SimulationRun {
    snapshot: SimulationSnapshot;
    fingerprint: string;
    child: ChildProcess;
    done: boolean;
}

// 此管理器只啟動模擬子程序；實站瀏覽器占用與人工停止留到 GUI 執行階段。
export class SimulationRuns {
    private requests = new Map<string, SimulationRun>();
    private current?: SimulationRun;
    private listeners = new Set<() => void>();

    hasRequest(id: string): boolean {
        return this.requests.has(id);
    }

    snapshot(): SimulationSnapshot | null {
        return this.current ? structuredClone(this.current.snapshot) : null;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                /* 顯示中斷不影響子程序。 */
            }
        }
    }

    start(requestId: string, activity: unknown, contact: unknown): SimulationSnapshot {
        if (!z.string().uuid().safeParse(requestId).success) throw new Error("開始請求識別碼無效。");
        const input = structuredClone({ activity: parseActivity(activity), contact: validateContactDetails(contact) });
        const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        const existing = this.requests.get(requestId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error("同一開始請求不能更換設定。");
            return structuredClone(existing.snapshot);
        }
        if (this.current?.snapshot.status === "running") throw new Error("已有模擬正在執行。");
        // 不丟棄去重紀錄；到上限明確要求重開模擬服務，不讓舊請求變成新購票。
        if (this.requests.size >= 100) throw new Error("本機模擬已達 100 次，請重新啟動服務。");
        const child = fork(fileURLToPath(new URL("./simulationWorker.ts", import.meta.url)), [], {
            cwd: projectRoot,
            execArgv: ["--import", "tsx"],
            env: { ...process.env, FLOW_PAUSE: "" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const run: SimulationRun = {
            snapshot: { id: randomUUID(), status: "running", events: [], historyTruncated: false },
            fingerprint,
            child,
            done: false,
        };
        this.current = run;
        this.requests.set(requestId, run);
        let sequence = 0;
        child.on("message", (value: unknown) => {
            if (!value || typeof value !== "object" || !("type" in value)) return;
            if (value.type === "done") {
                run.done = true;
                return;
            }
            if (value.type !== "event" || !("event" in value)) return;
            const event = value.event as RunEvent;
            if (!event || (event.type !== "state" && event.type !== "log")) return;
            run.snapshot.events.push({ sequence: ++sequence, at: new Date().toISOString(), event });
            if (run.snapshot.events.length > 300) {
                run.snapshot.events.shift();
                run.snapshot.historyTruncated = true;
            }
            this.notify();
        });
        child.on("error", () => {
            run.done = false;
        });
        child.on("close", code => {
            run.snapshot.status = code === 0 && run.done ? "completed" : "interrupted";
            this.notify();
        });
        child.send(input, error => {
            if (error) child.kill();
        });
        this.notify();
        return structuredClone(run.snapshot);
    }

    async close(): Promise<void> {
        const child = this.current?.child;
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise<void>(resolve => {
                child.once("close", () => resolve());
                child.kill();
            });
        }
        this.listeners.clear();
    }
}
