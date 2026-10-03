import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseActivity, projectRoot } from "../config/activityStore.js";
import { validateContactDetails } from "../config/contact.config.js";
import { validateSaleSchedule } from "../core/purchaseValidation.js";
import { acquirePurchaseLease, purchaseOccupied } from "../app/purchaseLock.js";
import type { RunEvent } from "../core/logger.js";

export interface PurchaseSnapshot {
    id: string; requestId: string; activityName: string; saleAt?: string;
    status: "running" | "payment-ready" | "failed" | "unknown" | "interrupted";
    browserOpen: boolean; occupied: boolean; message: string;
    events: { sequence: number; at: string; event: RunEvent }[];
    historyTruncated: boolean;
}
interface Record { snapshot: PurchaseSnapshot; fingerprint: string; }

export class PurchaseRuns {
    private current?: Record;
    private child?: ChildProcess;
    private listeners = new Set<() => void>();
    private directory: string;
    constructor(private readonly root = join(projectRoot, "local-data"),
        private readonly worker = new URL("./purchaseWorker.ts", import.meta.url)) {
        this.directory = join(root, "runs");
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const files = readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
        const records = files.map(name => this.read(name.slice(0, -5))).filter(record => record !== undefined);
        this.current = records.sort((a, b) => b.snapshot.id.localeCompare(a.snapshot.id))[0];
        if (this.current && ["running"].includes(this.current.snapshot.status)) {
            this.current.snapshot.status = "interrupted";
            this.current.snapshot.message = "上次服務中斷，請檢查瀏覽器與訂單；不會自動續跑。";
            this.save(this.current);
        }
    }
    private file(id: string): string {
        if (!z.string().uuid().safeParse(id).success) throw new Error("開始請求識別碼無效。");
        return join(this.directory, `${id}.json`);
    }
    private read(id: string): Record | undefined {
        try {
            const record = JSON.parse(readFileSync(this.file(id), "utf8")) as Record;
            const valid = z.object({
                fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                snapshot: z.object({
                    id: z.string(), requestId: z.literal(id), activityName: z.string(), saleAt: z.string().optional(),
                    status: z.enum(["running", "payment-ready", "failed", "unknown", "interrupted"]),
                    browserOpen: z.boolean(), occupied: z.boolean(), message: z.string(), historyTruncated: z.boolean(),
                    events: z.array(z.object({ sequence: z.number().int(), at: z.string(),
                        event: z.object({ type: z.enum(["state", "log", "target", "recovery"]) }).passthrough(),
                    })).max(300),
                }),
            }).safeParse(record);
            if (!valid.success) throw new Error("Invalid run record");
            return record;
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("執行紀錄無法讀取，請先人工檢查。"); }
    }
    private save(record: Record, fresh = false): void {
        const path = this.file(record.snapshot.requestId);
        const data = JSON.stringify(record);
        if (fresh) writeFileSync(path, data, { flag: "wx", mode: 0o600 });
        else {
            const temporary = `${path}.${randomUUID()}.tmp`;
            writeFileSync(temporary, data, { mode: 0o600 });
            renameSync(temporary, path);
        }
    }
    snapshot(): PurchaseSnapshot | null {
        if (!this.current) return purchaseOccupied(this.root) ? {
            id: "", requestId: "", activityName: "其他購票程序", status: "interrupted", browserOpen: false,
            occupied: true, message: "CLI 或上次購票仍占用瀏覽器，請先檢查原流程。", events: [], historyTruncated: false,
        } : null;
        return { ...structuredClone(this.current.snapshot), occupied: purchaseOccupied(this.root) || !!this.child };
    }
    hasRequest(id: string): boolean {
        // 無法確認紀錄時保守視為已接受，不能授權 UI 換 ID 重送。
        try { return existsSync(this.file(id)); } catch { return true; }
    }
    busy(): boolean { return !!this.child || purchaseOccupied(this.root); }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    private notify(): void { for (const listener of this.listeners) { try { listener(); } catch {} } }

    start(requestId: string, activityInput: unknown, contactInput: unknown): PurchaseSnapshot {
        const activity = parseActivity(activityInput);
        const contact = validateContactDetails(contactInput);
        const fingerprint = createHash("sha256").update(JSON.stringify({ activity, contact })).digest("hex");
        const previous = this.read(requestId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) throw new Error("同一開始請求不能更換設定。");
            return { ...previous.snapshot, occupied: this.busy() };
        }
        if (this.busy()) throw new Error("已有購票程序或瀏覽器占用，請先關閉原購票瀏覽器。");
        if (activity.saleSchedule && Date.now() >= validateSaleSchedule(activity.saleSchedule) + 120_000) throw new Error("開賣等待時間已過，請更新時間或選擇立即開始。");
        const lease = acquirePurchaseLease(this.root);
        const record: Record = { fingerprint, snapshot: {
            id: `${Date.now()}-${randomUUID()}`, requestId, activityName: activity.eventName,
            saleAt: activity.saleSchedule?.saleAt, status: "running", browserOpen: false, occupied: true,
            message: "正在啟動購票，請勿重複開始。", events: [], historyTruncated: false,
        } };
        // 必須先留下去重紀錄才啟動；寫入或啟動異常保留占用，不猜測可重跑。
        this.save(record, true);
        this.current = record;
        const child = fork(fileURLToPath(this.worker), [], { cwd: projectRoot, detached: true, execArgv: ["--import", "tsx"],
            env: { ...process.env, FLOW_PAUSE: "" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        this.child = child;
        let clean = false;
        child.on("message", (value: any) => {
            try {
                if (value?.type === "event" && ["state", "log", "target", "recovery"].includes(value.event?.type)) {
                    record.snapshot.events.push({ sequence: (record.snapshot.events.at(-1)?.sequence ?? 0) + 1, at: new Date().toISOString(), event: value.event });
                    if (record.snapshot.events.length > 300) { record.snapshot.events.shift(); record.snapshot.historyTruncated = true; }
                } else if (value?.type === "browser") record.snapshot.browserOpen = value.open === true;
                else if (value?.type === "result" && ["payment-ready", "failed", "unknown"].includes(value.outcome)) {
                    record.snapshot.status = value.outcome; record.snapshot.message = value.message;
                } else if (value?.type === "finished") clean = true;
                else return;
                this.save(record); this.notify();
            } catch { child.kill(); }
        });
        const ended = (code: number | null) => {
            this.child = undefined;
            if (code !== 0 || !clean) {
                record.snapshot.status = "interrupted";
                record.snapshot.message = "購票程序異常中斷，提交結果可能未知；請檢查訂單，不會自動重跑。";
            }
            record.snapshot.occupied = purchaseOccupied(this.root);
            try { this.save(record); }
            catch {
                record.snapshot.status = "interrupted";
                record.snapshot.message = "執行紀錄寫入失敗，請檢查瀏覽器與訂單；不會自動重跑。";
            }
            finally { this.notify(); }
        };
        child.once("error", () => { clean = false; });
        child.once("close", ended);
        child.send(structuredClone({ activity, contact, lease }), error => { if (error) child.kill(); });
        this.notify();
        return this.snapshot()!;
    }
    close(): void {
        if (this.child) throw new Error("購票程序尚未結束；請先關閉購票瀏覽器，再關閉 GUI 服務。");
        this.listeners.clear();
    }
}
