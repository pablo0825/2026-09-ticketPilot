import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseActivity, projectRoot, type ActivityRecord, type ActivitySettings } from "../config/activityStore.js";
import { validateContactDetails } from "../config/contact.config.js";
import { validateSaleSchedule } from "../core/purchaseValidation.js";
import { acquirePurchaseLease, purchaseOccupied } from "../app/purchaseLock.js";
import type { RunEvent } from "../core/logger.js";

export interface PurchaseSnapshot {
    id: string;
    requestId: string;
    activityName: string;
    saleAt?: string;
    status: "running" | "payment-ready" | "failed" | "unknown" | "interrupted";
    canCloseBrowser?: boolean;
    browserOpen: boolean;
    occupied: boolean;
    message: string;
    events: { sequence: number; at: string; event: RunEvent }[];
    historyTruncated: boolean;
}

interface Record {
    snapshot: PurchaseSnapshot;
    fingerprint: string;
    activity?: { id: string; settingsHash: string };
}

export type ActivityExecutionStatus = "尚無執行紀錄" | "等待開賣" | "執行中" | "已執行" | "設定已更新";

function settingsHash(settings: ActivitySettings): string {
    return createHash("sha256")
        .update(JSON.stringify(parseActivity(settings)))
        .digest("hex");
}

export class PurchaseRuns {
    private current?: Record;
    private latestByActivity = new Map<string, Record>();
    private child?: ChildProcess;
    private listeners = new Set<() => void>();
    private directory: string;

    constructor(
        private readonly root = join(projectRoot, "local-data"),
        private readonly worker = new URL("./purchaseWorker.ts", import.meta.url),
    ) {
        // 讀取過去的執行紀錄，最新的當作目前紀錄
        this.directory = join(root, "runs");
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });

        const files = readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
        const records = files.map(name => this.read(name.slice(0, -5))).filter(record => record !== undefined);
        records.sort((a, b) => b.snapshot.id.localeCompare(a.snapshot.id));
        this.current = records[0];

        // 記住每個活動最新的一筆紀錄
        for (const record of records) {
            if (record.activity && !this.latestByActivity.has(record.activity.id)) {
                this.latestByActivity.set(record.activity.id, record);
            }
        }

        // 上次還在執行的紀錄，標成已中斷
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
            const valid = z
                .object({
                    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                    activity: z
                        .object({ id: z.string().uuid(), settingsHash: z.string().regex(/^[0-9a-f]{64}$/) })
                        .strict()
                        .optional(),
                    snapshot: z.object({
                        id: z.string(),
                        requestId: z.literal(id),
                        activityName: z.string(),
                        saleAt: z.string().optional(),
                        status: z.enum(["running", "payment-ready", "failed", "unknown", "interrupted"]),
                        browserOpen: z.boolean(),
                        occupied: z.boolean(),
                        message: z.string(),
                        historyTruncated: z.boolean(),
                        events: z
                            .array(
                                z.object({
                                    sequence: z.number().int(),
                                    at: z.string(),
                                    event: z
                                        .object({ type: z.enum(["state", "log", "target", "recovery"]) })
                                        .passthrough(),
                                }),
                            )
                            .max(300),
                    }),
                })
                .safeParse(record);
            if (!valid.success) throw new Error("Invalid run record");

            return record;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new Error("執行紀錄無法讀取，請先人工檢查。");
        }
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
        // 沒有本服務的紀錄時，檢查是否被其他購票程序占用
        if (!this.current) {
            return purchaseOccupied(this.root)
                ? {
                      id: "",
                      requestId: "",
                      activityName: "其他購票程序",
                      status: "interrupted",
                      browserOpen: false,
                      occupied: true,
                      message: "CLI 或上次購票仍占用瀏覽器，請先檢查原流程。",
                      events: [],
                      historyTruncated: false,
                  }
                : null;
        }

        return {
            ...structuredClone(this.current.snapshot),
            occupied: purchaseOccupied(this.root) || !!this.child,
            canCloseBrowser:
                !!this.child?.connected &&
                this.current.snapshot.browserOpen &&
                ["payment-ready", "failed", "unknown"].includes(this.current.snapshot.status),
        };
    }

    hasRequest(id: string): boolean {
        // 無法確認紀錄時保守視為已接受，不能授權 UI 換 ID 重送。
        try {
            return existsSync(this.file(id));
        } catch {
            return true;
        }
    }

    busy(): boolean {
        return !!this.child || purchaseOccupied(this.root);
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {}
        }
    }

    activityStatus(activity: ActivityRecord): ActivityExecutionStatus {
        const record = this.latestByActivity.get(activity.id);
        if (!record?.activity) return "尚無執行紀錄";

        // 只有本服務持有的現行 worker 能代表仍在執行，舊紀錄不推測續跑。
        if (record === this.current && this.child && record.snapshot.status === "running") {
            const state = record.snapshot.events.filter(item => item.event.type === "state").at(-1)?.event;
            return state?.type === "state" && state.state === "WAITING_FOR_SALE" ? "等待開賣" : "執行中";
        }

        return record.activity.settingsHash === settingsHash(activity.settings) ? "已執行" : "設定已更新";
    }

    start(requestId: string, activityInput: unknown, contactInput: unknown, activityId?: string): PurchaseSnapshot {
        // 檢查請求、活動與聯絡資料
        if (activityId !== undefined && !z.string().uuid().safeParse(activityId).success) {
            throw new Error("活動識別碼無效。");
        }

        const activity = parseActivity(activityInput);
        const contact = validateContactDetails(contactInput);
        const fingerprint = createHash("sha256").update(JSON.stringify({ activity, contact })).digest("hex");

        // 同一個請求重送時，回傳原本的結果
        const previous = this.read(requestId);
        if (previous) {
            if (previous.activity && previous.activity.id !== activityId) throw new Error("同一開始請求不能更換活動。");
            if (previous.fingerprint !== fingerprint) throw new Error("同一開始請求不能更換設定。");
            return previous.snapshot.id === this.current?.snapshot.id
                ? this.snapshot()!
                : { ...previous.snapshot, occupied: this.busy(), canCloseBrowser: false };
        }

        // 確認沒有占用，且還沒超過開賣等待期限
        if (this.busy()) throw new Error("已有購票程序或瀏覽器占用，請先關閉原購票瀏覽器。");
        if (activity.saleSchedule && Date.now() >= validateSaleSchedule(activity.saleSchedule) + 120_000) {
            throw new Error("開賣等待時間已過，請更新時間或選擇立即開始。");
        }

        // 取得占用並建立執行紀錄
        const lease = acquirePurchaseLease(this.root);
        const record: Record = {
            fingerprint,
            ...(activityId ? { activity: { id: activityId, settingsHash: settingsHash(activity) } } : {}),
            snapshot: {
                id: `${Date.now()}-${randomUUID()}`,
                requestId,
                activityName: activity.eventName,
                saleAt: activity.saleSchedule?.saleAt,
                status: "running",
                browserOpen: false,
                occupied: true,
                message: "正在啟動購票，請勿重複開始。",
                events: [],
                historyTruncated: false,
            },
        };

        // 必須先留下去重紀錄才啟動；寫入或啟動異常保留占用，不猜測可重跑。
        this.save(record, true);
        this.current = record;
        if (record.activity) this.latestByActivity.set(record.activity.id, record);

        // 啟動購票子程序
        const child = fork(fileURLToPath(this.worker), [], {
            cwd: projectRoot,
            detached: true,
            execArgv: ["--import", "tsx"],
            env: { ...process.env, FLOW_PAUSE: "" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        this.child = child;

        // 接收子程序回報的事件、瀏覽器狀態與結果
        let clean = false;
        child.on("message", (value: any) => {
            try {
                if (value?.type === "event" && ["state", "log", "target", "recovery"].includes(value.event?.type)) {
                    record.snapshot.events.push({
                        sequence: (record.snapshot.events.at(-1)?.sequence ?? 0) + 1,
                        at: new Date().toISOString(),
                        event: value.event,
                    });
                    if (record.snapshot.events.length > 300) {
                        record.snapshot.events.shift();
                        record.snapshot.historyTruncated = true;
                    }
                } else if (value?.type === "browser") {
                    record.snapshot.browserOpen = value.open === true;
                } else if (value?.type === "result" && ["payment-ready", "failed", "unknown"].includes(value.outcome)) {
                    record.snapshot.status = value.outcome;
                    record.snapshot.message = value.message;
                } else if (value?.type === "finished") {
                    clean = true;
                } else {
                    return;
                }

                this.save(record);
                this.notify();
            } catch {
                child.kill();
            }
        });

        // 子程序結束時，更新並儲存紀錄
        const ended = (code: number | null) => {
            this.child = undefined;
            if (code !== 0 || !clean) {
                record.snapshot.status = "interrupted";
                record.snapshot.message = "購票程序異常中斷，提交結果可能未知；請檢查訂單，不會自動重跑。";
            }

            record.snapshot.occupied = purchaseOccupied(this.root);
            try {
                this.save(record);
            } catch {
                record.snapshot.status = "interrupted";
                record.snapshot.message = "執行紀錄寫入失敗，請檢查瀏覽器與訂單；不會自動重跑。";
            } finally {
                this.notify();
            }
        };

        child.once("error", () => {
            clean = false;
        });
        child.once("close", ended);

        // 傳送設定給子程序
        child.send(structuredClone({ activity, contact, lease }), error => {
            if (error) child.kill();
        });

        this.notify();
        return this.snapshot()!;
    }

    async closeBrowser(runId: string): Promise<PurchaseSnapshot> {
        // 確認這次執行可以關閉瀏覽器
        const run = this.current?.snapshot;
        if (!run || run.id !== runId) throw new Error("執行紀錄已變更，請重新查看目前狀態。");
        if (run.status === "running") throw new Error("購票流程仍在執行，不能關閉瀏覽器。");
        if (!run.browserOpen && !this.child && !this.busy()) return this.snapshot()!;

        const child = this.child;
        if (!this.snapshot()?.canCloseBrowser || !child) {
            throw new Error("無法控制這次購票瀏覽器，請手動關閉並檢查原流程。");
        }

        // 只通知本服務擁有的 worker；占用仍由原流程在瀏覽器關閉後解除。
        await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => {
                clearTimeout(timer);
                child.off("close", onClose);
                child.off("message", onMessage);
                error ? reject(error) : resolve();
            };

            const onClose = () => finish();
            const onMessage = (value: any) => {
                if (value?.type === "close-error") finish(new Error("瀏覽器關閉失敗，請檢查原視窗或手動關閉。"));
            };

            const timer = setTimeout(
                () => finish(new Error("尚未確認瀏覽器關閉，請檢查原視窗；占用尚未強制解除。")),
                10_000,
            );

            child.once("close", onClose);
            child.on("message", onMessage);
            child.send({ type: "close-browser" }, error => {
                if (error) finish(new Error("無法傳送關閉指令，請手動關閉購票瀏覽器。"));
            });
        });

        // 確認瀏覽器與占用都已結束
        const result = this.snapshot()!;
        if (result.browserOpen || result.occupied) {
            throw new Error("瀏覽器或程序尚未確認正常結束，請人工檢查；占用不會強制解除。");
        }

        return result;
    }

    close(): void {
        if (this.child) throw new Error("購票程序尚未結束；請先關閉購票瀏覽器，再關閉 GUI 服務。");

        this.listeners.clear();
    }
}
