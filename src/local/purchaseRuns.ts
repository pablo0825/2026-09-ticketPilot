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
import { singleTicketPlusSelection, ticketPlusSessionSelection } from "../config/ticketPlusActivity.js";
import { ticketPlusEventSchema } from "./purchaseEvents.js";
import { sendLoginConfirmation } from "./sendLoginConfirmation.js";
import type { PurchaseEvent } from "./purchaseEvents.js";

export interface PurchaseSnapshot {
    platform: ActivitySettings["platform"] | null; // 外部占用沒有足夠資訊可辨識平台。
    id: string;
    requestId: string;
    activityName: string;
    saleAt?: string;
    status: "running" | "payment-ready" | "information-ready" | "failed" | "unknown" | "interrupted";
    canCloseBrowser?: boolean;
    loginConfirmation?: { confirmationId: string }; // 僅現行 worker 的即時交接資格，不從磁碟恢復。
    browserOpen: boolean;
    occupied: boolean;
    message: string;
    events: { sequence: number; at: string; event: PurchaseEvent }[];
    historyTruncated: boolean;
}

interface Record {
    snapshot: PurchaseSnapshot;
    fingerprint: string;
    fingerprintVersion?: 2 | 3 | 4 | 5;
    activity?: { id: string; settingsHash: string };
}

export type ActivityExecutionStatus = "尚無執行紀錄" | "等待開賣" | "執行中" | "已執行" | "設定已更新" | "舊版執行紀錄";

// 以正規化後的購票條件識別新版請求。
function fingerprintSettings(settings: ActivitySettings) {
    return parseActivity(settings);
}

function settingsHash(settings: ActivitySettings): string {
    return createHash("sha256")
        .update(JSON.stringify(fingerprintSettings(settings)))
        .digest("hex");
}

export class PurchaseRuns {
    private current?: Record;
    private latestByActivity = new Map<string, Record>();
    private child?: ChildProcess;
    private login?: { child: ChildProcess; record: Record; confirmationId: string; consumed: boolean };
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
                    fingerprintVersion: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
                    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
                    activity: z
                        .object({ id: z.string().uuid(), settingsHash: z.string().regex(/^[0-9a-f]{64}$/) })
                        .strict()
                        .optional(),
                    snapshot: z.object({
                        platform: z.enum(["klook", "ticketplus"]).optional(),
                        id: z.string(),
                        requestId: z.literal(id),
                        activityName: z.string(),
                        saleAt: z.string().optional(),
                        status: z.enum([
                            "running",
                            "payment-ready",
                            "information-ready",
                            "failed",
                            "unknown",
                            "interrupted",
                        ]),
                        browserOpen: z.boolean(),
                        occupied: z.boolean(),
                        message: z.string(),
                        historyTruncated: z.boolean(),
                        events: z
                            .array(
                                z.object({
                                    sequence: z.number().int(),
                                    at: z.string(),
                                    event: z.union([
                                        z
                                            .object({ type: z.enum(["state", "log", "target", "recovery"]) })
                                            .passthrough(),
                                        ticketPlusEventSchema,
                                    ]),
                                }),
                            )
                            .max(300),
                    }),
                })
                .safeParse(record);
            if (!valid.success) throw new Error("Invalid run record");
            const platform = valid.data.snapshot.platform ?? "klook";
            if (record.fingerprintVersion === 5 && platform !== "ticketplus") {
                throw new Error("Invalid fingerprint platform");
            }
            if (
                platform !== "ticketplus" &&
                (valid.data.snapshot.status === "information-ready" ||
                    valid.data.snapshot.events.some(item => item.event.type === "ticketplus"))
            ) {
                throw new Error("Invalid platform event or result");
            }

            // 已知舊格式沒有平台，當時只有 Klook；保留原事件與指紋內容。
            return { ...record, snapshot: { ...record.snapshot, platform: valid.data.snapshot.platform ?? "klook" } };
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
        // 沒有紀錄時才合成未知平台；已有紀錄須保留事故細節供人工確認。
        if (!this.current && purchaseOccupied(this.root)) {
            return {
                platform: null,
                id: "",
                requestId: "",
                activityName: "其他購票程序",
                status: "interrupted",
                browserOpen: false,
                occupied: true,
                message: "CLI 或上次購票仍占用瀏覽器，請先檢查原流程。",
                events: [],
                historyTruncated: false,
            };
        }
        if (!this.current) return null;

        return {
            ...structuredClone(this.current.snapshot),
            occupied: purchaseOccupied(this.root) || !!this.child,
            loginConfirmation: this.loginAvailable() ? { confirmationId: this.login!.confirmationId } : undefined,
            canCloseBrowser:
                !!this.child?.connected &&
                this.current.snapshot.browserOpen &&
                ["payment-ready", "information-ready", "failed", "unknown"].includes(this.current.snapshot.status),
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

        if (record.fingerprintVersion !== 4 && record.fingerprintVersion !== 5) return "舊版執行紀錄";
        // 舊 TicketPlus 紀錄依原單目標形狀比對，純格式轉換不算設定變更。
        if (record.fingerprintVersion === 4 && activity.settings.platform === "ticketplus") {
            if (activity.settings.targets.length !== 1 || activity.settings.saleSchedule) return "設定已更新";
            const legacyHash = createHash("sha256")
                .update(JSON.stringify(singleTicketPlusSelection(activity.settings)))
                .digest("hex");
            return record.activity.settingsHash === legacyHash ? "已執行" : "設定已更新";
        }
        return record.activity.settingsHash === settingsHash(activity.settings) ? "已執行" : "設定已更新";
    }

    start(requestId: string, activityInput: unknown, contactInput: unknown, activityId?: string): PurchaseSnapshot {
        // 檢查請求、活動與聯絡資料
        if (activityId !== undefined && !z.string().uuid().safeParse(activityId).success) {
            throw new Error("活動識別碼無效。");
        }

        const activity = parseActivity(activityInput);
        if (activity.platform === "ticketplus" && contactInput !== undefined) {
            throw new Error("TicketPlus 本階段不接受聯絡資料。");
        }
        const contact = activity.platform === "klook" ? validateContactDetails(contactInput) : undefined;
        const fingerprint = createHash("sha256")
            .update(
                JSON.stringify(
                    activity.platform === "klook"
                        ? { activity: fingerprintSettings(activity), contact }
                        : { activity: fingerprintSettings(activity) },
                ),
            )
            .digest("hex");

        // 同一個請求重送時，回傳原本的結果
        const legacyFingerprint =
            activity.platform === "ticketplus" && activity.targets.length === 1 && !activity.saleSchedule
                ? createHash("sha256")
                      .update(JSON.stringify({ activity: singleTicketPlusSelection(activity) }))
                      .digest("hex")
                : undefined;
        const previous = this.previousResult(requestId, activityId, fingerprint, activity.platform, legacyFingerprint);
        if (previous) return previous;
        if (activity.platform === "ticketplus") ticketPlusSessionSelection(activity);

        // 確認沒有占用，且還沒超過開賣等待期限
        if (this.busy()) throw new Error("已有購票程序或瀏覽器占用，請先關閉原購票瀏覽器。");
        if (
            activity.platform === "klook" &&
            activity.saleSchedule &&
            Date.now() >= validateSaleSchedule(activity.saleSchedule) + 120_000
        ) {
            throw new Error("開賣等待時間已過，請更新時間或選擇立即開始。");
        }

        // 取得占用並建立執行紀錄
        const lease = acquirePurchaseLease(this.root);
        const record: Record = {
            fingerprintVersion: activity.platform === "ticketplus" ? 5 : 4,
            fingerprint,
            ...(activityId ? { activity: { id: activityId, settingsHash: settingsHash(activity) } } : {}),
            snapshot: {
                platform: activity.platform,
                id: `${Date.now()}-${randomUUID()}`,
                requestId,
                activityName: activity.eventName,
                ...(activity.platform === "klook" ? { saleAt: activity.saleSchedule?.saleAt } : {}),
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

        // 啟動購票子程序，並接收它的回報
        const child = fork(fileURLToPath(this.worker), [], {
            cwd: projectRoot,
            detached: true,
            execArgv: ["--import", "tsx"],
            env: { ...process.env, FLOW_PAUSE: "" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        this.child = child;
        this.login = undefined;
        this.attachWorker(child, record);

        // 傳送設定給子程序
        const workerInput = activity.platform === "klook" ? { activity, contact, lease } : { activity, lease };
        child.send(structuredClone(workerInput), error => {
            if (error) child.kill();
        });

        this.notify();
        return this.snapshot()!;
    }

    // 同一請求只能回傳原結果；換活動或換設定都拒絕。
    private previousResult(
        requestId: string,
        activityId: string | undefined,
        fingerprint: string,
        platform: ActivitySettings["platform"],
        legacyFingerprint?: string,
    ): PurchaseSnapshot | undefined {
        const previous = this.read(requestId);
        if (!previous) return undefined;

        if (previous.fingerprintVersion !== 4 && previous.fingerprintVersion !== 5) {
            throw new Error("舊版開始請求結果需人工確認，請檢查原流程與訂單；不會重新啟動。");
        }
        if (previous.snapshot.platform !== platform) throw new Error("同一開始請求不能更換平台。");
        if (previous.activity && previous.activity.id !== activityId) throw new Error("同一開始請求不能更換活動。");
        const expectedFingerprint =
            platform === "ticketplus" && previous.fingerprintVersion === 4 ? legacyFingerprint : fingerprint;
        if (previous.fingerprint !== expectedFingerprint) throw new Error("同一開始請求不能更換設定。");

        const current = this.snapshot();
        return previous.snapshot.id === current?.id
            ? current
            : { ...previous.snapshot, occupied: this.busy(), canCloseBrowser: false };
    }

    private loginAvailable(): boolean {
        const login = this.login;
        return Boolean(
            login &&
            !login.consumed &&
            login.child === this.child &&
            login.child.connected &&
            login.record === this.current &&
            login.record.snapshot.platform === "ticketplus" &&
            login.record.snapshot.status === "running" &&
            login.record.snapshot.browserOpen,
        );
    }

    async confirmLogin(
        runId: string,
        confirmationId: string,
    ): Promise<{ status: "sent"; message: string; run: PurchaseSnapshot }> {
        // 比對本輪即時資格，不能使用磁碟中的歷史 login-ready 或其他程序。
        const login = this.login;
        if (
            !this.loginAvailable() ||
            !login ||
            runId !== login.record.snapshot.id ||
            confirmationId !== login.confirmationId ||
            !z.string().uuid().safeParse(confirmationId).success
        ) {
            throw new Error("登入確認尚未就緒、已送出或已失效，請查看目前執行狀態。");
        }

        // 先消耗並留下嘗試紀錄，再傳送；任何失敗都不能重新啟用確認資格。
        login.consumed = true;
        const events = login.record.snapshot.events;
        events.push({
            sequence: (events.at(-1)?.sequence ?? 0) + 1,
            at: new Date().toISOString(),
            event: { type: "log", message: "已開始傳送人工登入確認，後續請查看執行狀態。" },
        });
        if (events.length > 300) {
            events.shift();
            login.record.snapshot.historyTruncated = true;
        }
        try {
            this.save(login.record);
        } catch {
            login.child.kill();
            this.notify();
            throw new Error("執行紀錄寫入失敗，未傳送登入確認；請檢查原流程，不會自動重跑。");
        }
        this.notify();

        // 只等待有界的 IPC 傳送，不占住 API 直到整個購票流程結束。
        await sendLoginConfirmation(login.child, confirmationId);
        return { status: "sent", message: "已送出登入確認，請查看後續執行狀態。", run: this.snapshot()! };
    }

    private invalidateLogin(child: ChildProcess): void {
        if (this.login?.child === child) this.login.consumed = true;
    }

    // 接收子程序回報；結束時依是否正常完成更新紀錄。
    private attachWorker(child: ChildProcess, record: Record): void {
        // 只有收到 finished 且沒有錯誤，才算正常結束
        let clean = false;

        // 接收子程序回報的事件、瀏覽器狀態與結果
        child.on("message", (value: any) => {
            try {
                const ticketPlusEvent = ticketPlusEventSchema.safeParse(value?.event);
                if (
                    value?.type === "event" &&
                    (["state", "log", "target", "recovery"].includes(value.event?.type) ||
                        (record.snapshot.platform === "ticketplus" && ticketPlusEvent.success))
                ) {
                    record.snapshot.events.push({
                        sequence: (record.snapshot.events.at(-1)?.sequence ?? 0) + 1,
                        at: new Date().toISOString(),
                        event: ticketPlusEvent.success ? ticketPlusEvent.data : value.event,
                    });
                    if (record.snapshot.events.length > 300) {
                        record.snapshot.events.shift();
                        record.snapshot.historyTruncated = true;
                    }
                } else if (value?.type === "browser") {
                    record.snapshot.browserOpen = value.open === true;
                } else if (
                    value?.type === "result" &&
                    (["failed", "unknown"].includes(value.outcome) ||
                        (record.snapshot.platform === "klook" && value.outcome === "payment-ready") ||
                        (record.snapshot.platform === "ticketplus" && value.outcome === "information-ready"))
                ) {
                    record.snapshot.status = value.outcome;
                    record.snapshot.message = value.message;
                } else if (value?.type === "finished") {
                    clean = true;
                } else {
                    return;
                }

                this.save(record);
                // 事件成功落盤後才開放交接；同一輪只接受第一次 ready，不因重複事件恢復資格。
                if (child === this.child && record === this.current && record.snapshot.platform === "ticketplus") {
                    if (
                        value.type === "event" &&
                        ticketPlusEvent.success &&
                        ticketPlusEvent.data.stage === "login-ready" &&
                        !this.login &&
                        record.snapshot.status === "running" &&
                        record.snapshot.browserOpen &&
                        child.connected
                    ) {
                        this.login = {
                            child,
                            record,
                            confirmationId: ticketPlusEvent.data.confirmationId,
                            consumed: false,
                        };
                    } else if (
                        value.type === "result" ||
                        (value.type === "browser" && !value.open) ||
                        (value.type === "event" &&
                            ticketPlusEvent.success &&
                            ticketPlusEvent.data.stage !== "login-ready")
                    ) {
                        this.invalidateLogin(child);
                    }
                }
                this.notify();
            } catch {
                this.invalidateLogin(child);
                child.kill();
            }
        });

        // 子程序結束時，更新並儲存紀錄
        const ended = (code: number | null) => {
            this.invalidateLogin(child);
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

        child.once("disconnect", () => {
            this.invalidateLogin(child);
            this.notify();
        });
        child.once("error", () => {
            this.invalidateLogin(child);
            clean = false;
        });
        child.once("close", ended);
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
