import { localDataDirectory, projectRoot } from "../../storage/dataPaths.js";
import type { ActivityExecutionStatus } from "../../shared/activityExecutionStatus.js";
import type { ActivityRecord } from "../../shared/activityRecord.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseActivity, type ActivitySettings } from "../../config/activitySettings.js";
import { acquirePurchaseLease, purchaseOccupied } from "../../storage/purchaseLock.js";
import { runCapabilities } from "../../app/platforms/runCapabilities.js";
import { executionPlatform, platformFor } from "../../app/platforms/executionRegistry.js";
import { runSnapshotFields, type BoundRunRules } from "../../app/platforms/platformDefinition.js";
import { sendWorkerStop } from "./sendWorkerStop.js";
import type { PurchaseEvent } from "../../shared/runEvents.js";
import type { PurchaseSnapshot } from "../../shared/runSnapshot.js";
import type { RunRecord } from "./runRecord.js";
import { RunRecordStore } from "./runRecordStore.js";
import { parseWorkerReport } from "../../workers/workerReports.js";

function hashContent(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// 活動 id 只存在紀錄的活動資料，交給畫面時才帶入快照。
function withActivityId(record: RunRecord, snapshot: PurchaseSnapshot): PurchaseSnapshot {
    return record.activity ? { ...snapshot, activityId: record.activity.id } : snapshot;
}

export class PurchaseRuns {
    private current?: RunRecord;
    private latestByActivity = new Map<string, RunRecord>();
    private child?: ChildProcess;
    private stopRequest?: { child: ChildProcess; record: RunRecord; status: "sending" | "sent" | "unconfirmed" };
    private participantsSent?: { record: RunRecord; confirmationId: string };
    private listeners = new Set<() => void>();
    private readonly recordStore: RunRecordStore;

    constructor(
        private readonly root = localDataDirectory,
        private readonly worker = new URL("../../workers/purchaseWorker.ts", import.meta.url),
    ) {
        this.recordStore = new RunRecordStore(root);

        // 讀取過去的執行紀錄（已排除封存平台），最新的當作目前紀錄
        const records = this.recordStore.loadAll();
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
            this.recordStore.replace(this.current);
        }
    }

    snapshot(): PurchaseSnapshot | null {
        // 沒有紀錄時才合成未知平台；已有紀錄須保留事故細節供人工確認。
        if (!this.current && purchaseOccupied(this.root)) {
            return {
                platform: null,
                capabilities: runCapabilities(null),
                id: "",
                requestId: "",
                activityName: "其他購票程序",
                status: "interrupted",
                browserOpen: false,
                occupied: true,
                message: "其他程序或上次購票仍占用瀏覽器，請先檢查原流程。",
                events: [],
                historyTruncated: false,
            };
        }
        if (!this.current) return null;

        return {
            ...withActivityId(this.current, structuredClone(this.current.snapshot)),
            capabilities: runCapabilities(this.current.snapshot.platform),
            occupied: purchaseOccupied(this.root) || !!this.child,
            canStop: this.stopAvailable(),
            stopRequest: this.stopRequest?.record === this.current ? { status: this.stopRequest.status } : undefined,
            loginConfirmation: undefined,
            participantConfirmation: this.pendingParticipants(),
            canCloseBrowser:
                !!this.child?.connected &&
                this.current.snapshot.browserOpen &&
                ["payment-ready", "information-ready", "registration-ready", "failed", "unknown"].includes(
                    this.current.snapshot.status,
                ),
        };
    }

    hasRequest(id: string): boolean {
        // 無法確認紀錄時保守視為已接受，不能授權 UI 換 ID 重送。
        try {
            return this.recordStore.exists(id);
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
            return executionPlatform(record.snapshot.platform).waitingForSale(record.snapshot.events)
                ? "等待開賣"
                : "執行中";
        }

        const rules = platformFor(activity.settings);
        if (record.snapshot.platform !== activity.settings.platform) return "設定已更新";
        if (!rules.comparableVersions.some(version => version === record.fingerprintVersion)) return "舊版執行紀錄";

        const content = rules.settingsContent(record.fingerprintVersion);
        return content !== undefined && record.activity.settingsHash === hashContent(content) ? "已執行" : "設定已更新";
    }

    start(requestId: string, activityInput: unknown, activityId?: string): PurchaseSnapshot {
        // 檢查請求與活動
        if (activityId !== undefined && !z.string().uuid().safeParse(activityId).success) {
            throw new Error("活動識別碼無效。");
        }

        const activity = parseActivity(activityInput);
        const rules = platformFor(activity);
        const fingerprint = hashContent(rules.requestContent(rules.fingerprintVersion));

        const previous = this.previousResult(requestId, activityId, activity.platform, rules);
        if (previous) return previous;

        rules.validateStart();
        if (this.busy()) throw new Error("已有購票程序或瀏覽器占用，請先關閉原購票瀏覽器。");
        rules.validateSchedule(Date.now());

        // 取得占用並建立執行紀錄
        const lease = acquirePurchaseLease(this.root);
        const record: RunRecord = {
            fingerprintVersion: rules.fingerprintVersion,
            fingerprint,
            ...(activityId
                ? {
                      activity: {
                          id: activityId,
                          settingsHash: hashContent(rules.settingsContent(rules.fingerprintVersion)),
                      },
                  }
                : {}),
            snapshot: {
                platform: activity.platform,
                id: `${Date.now()}-${randomUUID()}`,
                requestId,
                ...runSnapshotFields(rules.snapshotFields),
                status: "running",
                browserOpen: false,
                occupied: true,
                message: "正在啟動購票，請勿重複開始。",
                events: [],
                historyTruncated: false,
            },
        };

        // 必須先留下去重紀錄才啟動；寫入或啟動異常保留占用，不猜測可重跑。
        this.recordStore.create(record);
        this.current = record;
        if (record.activity) this.latestByActivity.set(record.activity.id, record);

        // 啟動購票子程序，並接收它的回報
        const child = fork(fileURLToPath(this.worker), [], {
            cwd: projectRoot,
            detached: true,
            execArgv: ["--import", "tsx"],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        this.child = child;
        this.stopRequest = undefined;
        this.attachWorker(child, record);

        // 傳送設定給子程序
        child.send(structuredClone({ activity, lease }), error => {
            if (error) child.kill();
        });

        this.notify();
        return this.snapshot()!;
    }

    // 同一請求只能回傳原結果；換活動或換設定都拒絕。
    private previousResult(
        requestId: string,
        activityId: string | undefined,
        platform: string,
        rules: BoundRunRules,
    ): PurchaseSnapshot | undefined {
        const previous = this.recordStore.read(requestId);
        if (previous === "archived-klook") throw new Error("此開始請求屬於已停用的 Klook 流程，不會重新啟動。");
        if (!previous) return undefined;

        if (!rules.comparableVersions.some(version => version === previous.fingerprintVersion)) {
            throw new Error("舊版開始請求結果需人工確認，請檢查原流程與訂單；不會重新啟動。");
        }
        if (previous.activity && previous.activity.id !== activityId) throw new Error("同一開始請求不能更換活動。");

        const content = rules.requestContent(previous.fingerprintVersion);
        const expectedFingerprint = content === undefined ? undefined : hashContent(content);
        if (previous.snapshot.platform !== platform) throw new Error("同一開始請求不能更換設定。");
        if (previous.fingerprint !== expectedFingerprint) throw new Error("同一開始請求不能更換設定。");

        const current = this.snapshot();
        return previous.snapshot.id === current?.id
            ? current
            : {
                  ...withActivityId(previous, previous.snapshot),
                  capabilities: runCapabilities(previous.snapshot.platform),
                  occupied: this.busy(),
                  canCloseBrowser: false,
              };
    }

    private stopAvailable(): boolean {
        return Boolean(
            this.child?.connected &&
            this.current &&
            executionPlatform(this.current.snapshot.platform).stop &&
            this.current.snapshot.status === "running" &&
            this.stopRequest?.record !== this.current,
        );
    }

    async stop(runId: string): Promise<{
        status: "sending" | "sent" | "unconfirmed";
        message: string;
        run: PurchaseSnapshot;
    }> {
        // 只控制本服務的現行執行；同一輪已提出的要求不再次傳送。
        const record = this.current;
        if (!record || record.snapshot.id !== runId) {
            throw new Error("執行紀錄已變更，請重新查看目前狀態。");
        }

        const existing = this.stopRequest;
        if (existing?.record === record) return this.stopResponse(existing);

        const child = this.child;
        const definition = executionPlatform(record.snapshot.platform);
        if (!this.stopAvailable() || !child || !definition.stop) {
            throw new Error(`目前沒有可停止的 ${definition.name} 執行，請查看目前狀態。`);
        }

        // 先固定停止要求；停止傳送不能依賴磁碟寫入成功。
        const request = { child, record, status: "sending" as "sending" | "sent" | "unconfirmed" };
        this.stopRequest = request;
        this.notify();

        // 傳送完成只更新要求狀態，購票結果仍由 worker 回報。
        try {
            await sendWorkerStop(child, definition.stop.message);
            request.status = "sent";
        } catch {
            request.status = "unconfirmed";
        }

        if (this.current === record && this.child === child) this.notify();
        return this.stopResponse(request);
    }

    private stopResponse(request: NonNullable<PurchaseRuns["stopRequest"]>) {
        const { status, record } = request;
        const messages = {
            sending: "正在傳送停止要求，請查看後續執行狀態。",
            sent: "已送出停止要求，尚不代表流程已停止；請查看後續執行狀態。",
            unconfirmed: "停止要求傳送結果未確認，請檢查目前流程；不會自動重送。",
        };

        const run =
            this.current === record
                ? this.snapshot()!
                : {
                      ...withActivityId(record, structuredClone(record.snapshot)),
                      capabilities: runCapabilities(record.snapshot.platform),
                      occupied: this.busy(),
                      canStop: false,
                      canCloseBrowser: false,
                      stopRequest: { status },
                  };

        return { status, message: messages[status], run };
    }

    // 只有本服務現行的 TicketPlus 執行、最後進度為等待參加者且尚未送出確認時，才提供確認 ID。
    private pendingParticipants(): { confirmationId: string } | undefined {
        const record = this.current;
        if (!record || record.snapshot.status !== "running") {
            return undefined;
        }

        // 已提出停止要求後不再提供確認，避免停止中又繼續收尾。
        if (this.stopRequest?.record === record) return undefined;
        if (!this.child?.connected) return undefined;

        const confirmationId = executionPlatform(record.snapshot.platform).participants?.pending(
            record.snapshot.events,
        );
        if (!confirmationId) return undefined;
        if (this.participantsSent?.record === record && this.participantsSent.confirmationId === confirmationId)
            return undefined;

        return { confirmationId };
    }

    // 轉送「參加者已填完」：ID 須與目前等待相同；每個等待只轉送一次，不重送。
    async confirmParticipants(
        runId: string,
        confirmationId: string,
    ): Promise<{ status: "sent" | "unconfirmed"; message: string; run: PurchaseSnapshot }> {
        const record = this.current;
        if (!record || record.snapshot.id !== runId) throw new Error("執行紀錄已變更，請重新查看目前狀態。");

        const participants = executionPlatform(record.snapshot.platform).participants;
        const pending = this.pendingParticipants();
        const child = this.child;
        if (!participants || !pending) {
            throw new Error("目前沒有等待中的參加者確認，或確認已送出；不會重送。");
        }

        if (pending.confirmationId !== confirmationId) {
            throw new Error("目前沒有等待中的參加者確認，或確認已送出；不會重送。");
        }

        if (!child) {
            throw new Error("目前沒有等待中的參加者確認，或確認已送出；不會重送。");
        }

        // 先記錄已送出，再傳送；傳送失敗也不重送，由 worker 結果決定後續。
        this.participantsSent = { record, confirmationId };
        this.notify();

        const delivered = await new Promise<boolean>(resolve => {
            child.send(participants.message(confirmationId), error => resolve(!error));
        });

        return delivered
            ? {
                  status: "sent",
                  message: "已送出參加者已填完，程式會核對後勾選條款並按一次下一步。",
                  run: this.snapshot()!,
              }
            : {
                  status: "unconfirmed",
                  message: "參加者確認傳送結果未確認，請檢查目前流程；不會自動重送。",
                  run: this.snapshot()!,
              };
    }

    async confirmLogin(
        _runId: string,
        _confirmationId: string,
    ): Promise<{ status: "sent"; message: string; run: PurchaseSnapshot }> {
        // 舊客戶端請求不能跳過目前由瀏覽器觀測的登入驗證。
        throw new Error("人工登入確認已停用，請在購票瀏覽器登入，系統會自動確認；不會重新購票。");
    }

    // 接收子程序回報；結束時依是否正常完成更新紀錄。
    private attachWorker(child: ChildProcess, record: RunRecord): void {
        // 只有收到 finished 且沒有錯誤，才算正常結束
        let clean = false;
        let invalidReport = false;

        // 接收子程序回報的事件、瀏覽器狀態與結果
        child.on("message", (value: unknown) => {
            if (invalidReport) return;

            try {
                const definition = executionPlatform(record.snapshot.platform);
                const report = parseWorkerReport(value, definition);
                if (!report || report.type === "close-error") return;

                if (report.type === "event") {
                    record.snapshot.events.push({
                        sequence: (record.snapshot.events.at(-1)?.sequence ?? 0) + 1,
                        at: new Date().toISOString(),
                        event: report.event,
                    });

                    if (record.snapshot.events.length > 300) {
                        record.snapshot.events.shift();
                        record.snapshot.historyTruncated = true;
                    }
                } else if (report.type === "browser") {
                    record.snapshot.browserOpen = report.open;
                } else if (report.type === "result") {
                    record.snapshot.status = report.outcome;
                    record.snapshot.message = report.message;

                    // 只保留 TicketPlus 已知的停止原因，其他值不寫入紀錄。
                    if (report.stopReason) {
                        record.snapshot.stopReason = report.stopReason;
                    }
                } else if (report.type === "finished") {
                    clean = true;
                } else {
                    return;
                }

                this.recordStore.replace(record);
                this.notify();
            } catch {
                invalidReport = true;
                clean = false;
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
                this.recordStore.replace(record);
            } catch {
                record.snapshot.status = "interrupted";
                record.snapshot.message = "執行紀錄寫入失敗，請檢查瀏覽器與訂單；不會自動重跑。";
            } finally {
                this.notify();
            }
        };

        child.once("disconnect", () => {
            this.notify();
        });
        child.once("error", () => {
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
            const onMessage = (value: unknown) => {
                try {
                    const report = parseWorkerReport(value, executionPlatform(run.platform));
                    if (report?.type === "close-error") finish(new Error("瀏覽器關閉失敗，請檢查原視窗或手動關閉。"));
                } catch {
                    finish(new Error("購票程序回報無效，請檢查原視窗；占用不會強制解除。"));
                }
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
