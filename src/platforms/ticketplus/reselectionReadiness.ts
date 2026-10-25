import type { Page } from "playwright";
import { readTicketPlusPage } from "./pageState.js";
import { validDate, validTime } from "./readResult.js";
import { TicketPlusStopError } from "./runControl.js";
import type { TicketPlusRunControl, TicketPlusStopReason } from "./runControl.js";
import type { TicketPlusSubmissionResult } from "./submissionOutcome.js";
import type { VerifiedTicketPlusSession } from "./ticketQuantity.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";

export type ReselectionBlockedReason =
    | "invalid-session"
    | "invalid-options"
    | "submission-stopped"
    | "submission-not-rejected"
    | "submission-not-attempted"
    | "failure-not-sold-out"
    | "dismissal-unconfirmed"
    | "unexpected-page"
    | "identity-mismatch"
    | "remaining-quantity"
    | "read-timeout"
    | "read-failed";

export type TicketPlusReselectionReadiness =
    | { kind: "ready"; snapshot: TicketSelectionPage }
    | { kind: "blocked"; reason: ReselectionBlockedReason; stopReason?: TicketPlusStopReason };

export interface ReselectionReadinessOptions {
    readTimeoutMs?: number;
}

// 呼叫端須提供本輪提交結果、同輪場次與原控制器；此處不從歷史紀錄恢復重試資格。
// ready 只描述這次快照，後續動作仍須重新核對，且重選時要求初始張數全部為零。
export async function inspectTicketPlusReselection(
    page: Page,
    session: VerifiedTicketPlusSession,
    result: TicketPlusSubmissionResult,
    control: TicketPlusRunControl,
    options: ReselectionReadinessOptions = {},
): Promise<TicketPlusReselectionReadiness> {
    // 先保存場次並確認本輪確實因售完結束，停止結果不得重新取得資格。
    control.check();
    const identity = { ...session };
    const blocked = (reason: ReselectionBlockedReason): TicketPlusReselectionReadiness => ({ kind: "blocked", reason });
    if (result.stopReason) return { kind: "blocked", reason: "submission-stopped", stopReason: result.stopReason };
    if (result.outcome !== "rejected" || result.reason !== "order-rejected") return blocked("submission-not-rejected");
    if (!result.progress.submitAttempted) return blocked("submission-not-attempted");
    if (result.progress.failure !== "sold-out") return blocked("failure-not-sold-out");
    if (result.progress.dismissal !== "confirmed" && result.progress.dismissal !== "disappeared") {
        return blocked("dismissal-unconfirmed");
    }

    // 驗證場次資料與讀取上限，不接受空白身分或無限等待。
    const fields = [identity.eventId, identity.sessionId, identity.eventName, identity.date, identity.time];
    if (fields.some(value => typeof value !== "string" || !value.trim())) {
        return blocked("invalid-session");
    }

    if (!/^[A-Za-z0-9_-]+$/.test(identity.eventId) || !/^[A-Za-z0-9_-]+$/.test(identity.sessionId)) {
        return blocked("invalid-session");
    }

    if (!validDate(identity.date) || !validTime(identity.time)) {
        return blocked("invalid-session");
    }

    const timeout = options.readTimeoutMs ?? 2_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) return blocked("invalid-options");

    // 唯讀取得最新完整頁面；短期限與全程期限都不因重新核對而重設。
    const deadline = performance.now() + timeout;
    const timeoutError = new Error("TicketPlus 重新選票前核對逾時。");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot;
    try {
        snapshot = await control.read(() =>
            Promise.race([
                readTicketPlusPage(page),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(timeoutError), timeout);
                }),
            ]),
        );
        control.check();
        if (performance.now() >= deadline) return blocked("read-timeout");
    } catch (error) {
        control.check();
        if (error instanceof TicketPlusStopError) throw error;

        return blocked(error === timeoutError ? "read-timeout" : "read-failed");
    } finally {
        clearTimeout(timer);
    }

    // 彈窗消失仍可能停在排隊；只有同場次且所有已選張數清零才能放行。
    if (snapshot.kind === "unknown" && snapshot.reason === "read-failed") return blocked("read-failed");
    if (snapshot.kind !== "ticket-selection") return blocked("unexpected-page");
    if (
        snapshot.eventId !== identity.eventId ||
        snapshot.sessionId !== identity.sessionId ||
        snapshot.eventName !== identity.eventName ||
        snapshot.date !== identity.date ||
        snapshot.time !== identity.time
    ) {
        return blocked("identity-mismatch");
    }
    if (snapshot.tickets.some(ticket => ticket.selectedQuantity !== 0)) return blocked("remaining-quantity");

    return { kind: "ready", snapshot };
}
