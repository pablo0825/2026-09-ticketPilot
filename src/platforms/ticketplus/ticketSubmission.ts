import type { TicketPlusStopReason } from "./runControl.js";
import { TicketPlusRunControl, TicketPlusStopError } from "./runControl.js";
import type { Page } from "playwright";
import { parseTicketPlusSelection } from "../../config/ticketPlusActivity.js";
import type { TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import { readTicketPlusPage } from "./pageState.js";
import type { OrderFailurePage, TicketPlusPage, TicketPlusPageDiagnostic } from "./pageState.js";
import type { InformationPage } from "./informationPage.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";

export interface TicketSubmissionOptions {
    preflightTimeoutMs?: number;
    submitWaitMs?: number;
    queueWaitMs?: number;
    totalTimeoutMs?: number;
    clickTimeoutMs?: number;
    closeTimeoutMs?: number;
    readTimeoutMs?: number;
    pollIntervalMs?: number;
}
export type SubmissionReason =
    | "user-stopped"
    | "time-limit"
    | "invalid-input"
    | "invalid-options"
    | "unexpected-route"
    | "unexpected-page"
    | "selection-mismatch"
    | "button-unavailable"
    | "submit-click-failed"
    | "wait-timeout"
    | "read-timeout"
    | "read-failed"
    | "order-rejected"
    | "dismiss-unavailable"
    | "dismiss-changed"
    | "dismiss-unconfirmed";
export type Dismissal = "not-attempted" | "disappeared" | "confirmed" | "unconfirmed";
export interface SubmissionProgress {
    submitAttempted: boolean;
    dismissAttempted: boolean;
    sawQueue: boolean;
    failure?: OrderFailurePage["failure"];
    dismissal: Dismissal;
}
export interface SubmissionDiagnostic {
    phase: "before-submit" | "after-submit" | "dismiss-failure";
    page?: TicketPlusPageDiagnostic;
    routeFailure?: "origin-mismatch" | "extra-url-parts" | "path-mismatch" | "snapshot-identity-mismatch";
}
export class TicketPlusSubmissionError extends Error {
    constructor(
        public readonly reason: SubmissionReason,
        public readonly progress: Readonly<SubmissionProgress>,
        public readonly stopReason?: TicketPlusStopReason,
        public readonly diagnostic?: SubmissionDiagnostic,
    ) {
        super(`TicketPlus 選票提交停止（${reason}），不會刷新或重新提交。`);
        this.name = "TicketPlusSubmissionError";
    }
}
interface Submission {
    control: TicketPlusRunControl;
    settings: TicketPlusSelection;
    selected: TicketSelectionPage;
    options: Required<TicketSubmissionOptions>;
    deadline: number;
    progress: SubmissionProgress;
    observer?: SubmissionObserver;
    diagnostic?: SubmissionDiagnostic;
}
const defaults: Required<TicketSubmissionOptions> = {
    preflightTimeoutMs: 5_000,
    submitWaitMs: 10_000,
    queueWaitMs: 600_000,
    totalTimeoutMs: 615_000,
    clickTimeoutMs: 3_000,
    closeTimeoutMs: 3_000,
    readTimeoutMs: 2_000,
    pollIntervalMs: 500,
};
export type SubmissionObserver = (progress: Readonly<SubmissionProgress>) => void | Promise<void>;

export const emptySubmissionProgress = (): SubmissionProgress => ({
    submitAttempted: false,
    dismissAttempted: false,
    sawQueue: false,
    dismissal: "not-attempted",
});

// 通知只接收複本，失敗不能改變購票流程或觸發重試。
function notifyProgress(context: Submission): void {
    try {
        void Promise.resolve(context.observer?.(Object.freeze({ ...context.progress }))).catch(() => {});
    } catch {
        // 觀察者不是購票流程的一部分。
    }
}

function stop(context: Submission, reason: SubmissionReason): TicketPlusSubmissionError {
    return new TicketPlusSubmissionError(reason, { ...context.progress }, undefined, context.diagnostic);
}
function localRemaining(context: Submission, deadline: number): number {
    context.control.check();
    const value = Math.min(context.deadline, deadline) - performance.now();
    if (value <= 0) throw stop(context, "wait-timeout");
    return value;
}
function remaining(context: Submission, deadline: number): number {
    return Math.min(localRemaining(context, deadline), context.control.remainingMs());
}
async function readBounded<T>(context: Submission, deadline: number, read: () => Promise<T>): Promise<T> {
    // 只對唯讀工作設外層期限；逾時後停止，不另開下一個讀取。
    const timeout = Math.min(localRemaining(context, deadline), context.options.readTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const value = await context.control.read(() =>
            Promise.race([
                read(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(stop(context, "read-timeout")), timeout);
                }),
            ]),
        );
        remaining(context, deadline);
        return value;
    } finally {
        clearTimeout(timer);
    }
}
function checkRoute(page: Page, context: Submission, orderOnly = false): void {
    context.control.check();
    if (page.isClosed()) throw stop(context, "read-failed");
    const url = new URL(page.url());
    const suffix = `${context.selected.eventId}/${context.selected.sessionId}`;
    const paths = [`/order/${suffix}`, ...(orderOnly ? [] : [`/confirm/${suffix}`])];
    const routeFailure =
        url.origin !== "https://ticketplus.com.tw"
            ? "origin-mismatch"
            : url.search || url.hash || url.username || url.password
              ? "extra-url-parts"
              : !paths.includes(url.pathname.replace(/\/$/, ""))
                ? "path-mismatch"
                : undefined;
    if (routeFailure) {
        context.diagnostic = { ...context.diagnostic, phase: submissionPhase(context), routeFailure };
        throw stop(context, "unexpected-route");
    }
}
function submissionPhase(context: Submission): SubmissionDiagnostic["phase"] {
    return context.progress.failure
        ? "dismiss-failure"
        : context.progress.submitAttempted
          ? "after-submit"
          : "before-submit";
}

async function snapshot(
    page: Page,
    context: Submission,
    deadline: number,
    allowSelectionTransition = false,
): Promise<TicketPlusPage> {
    checkRoute(page, context);
    const phase = submissionPhase(context);
    const value = await readBounded(context, deadline, () =>
        readTicketPlusPage(
            page,
            diagnostic => {
                context.diagnostic = { phase, page: diagnostic };
            },
            undefined,
            allowSelectionTransition
                ? {
                      eventId: context.selected.eventId,
                      sessionId: context.selected.sessionId,
                      eventName: context.settings.eventName,
                      date: context.settings.target.date,
                      time: context.settings.target.time,
                      ticketType: context.settings.target.ticketType,
                      quantity: context.settings.target.quantity,
                  }
                : undefined,
        ),
    );
    checkRoute(page, context);
    if (
        value.kind !== "unknown" &&
        (value.eventId !== context.selected.eventId ||
            !("sessionId" in value) ||
            value.sessionId !== context.selected.sessionId)
    ) {
        context.diagnostic = { ...context.diagnostic, phase, routeFailure: "snapshot-identity-mismatch" };
        throw stop(context, "unexpected-route");
    }
    return value;
}
function verifySelection(context: Submission, value: TicketPlusPage): asserts value is TicketSelectionPage {
    if (value.kind !== "ticket-selection") throw stop(context, "unexpected-page");
    const { settings, selected } = context;
    const matches = value.tickets.filter(ticket => ticket.name === settings.target.ticketType);
    if (
        value.eventId !== selected.eventId ||
        value.sessionId !== selected.sessionId ||
        value.eventName !== settings.eventName ||
        value.date !== settings.target.date ||
        value.time !== settings.target.time ||
        matches.length !== 1 ||
        matches[0]!.saleStatus !== "selling" ||
        matches[0]!.selectedQuantity !== settings.target.quantity ||
        value.tickets.some(ticket => ticket !== matches[0] && ticket.selectedQuantity !== 0)
    ) {
        throw stop(context, "selection-mismatch");
    }
}
function xpathLiteral(value: string): string {
    if (!value.includes("'")) return `'${value}'`;
    if (!value.includes('"')) return `"${value}"`;
    return `concat(${value
        .split("'")
        .map(part => `'${part}'`)
        .join(', "\'", ')})`;
}
async function submitOnce(page: Page, context: Submission, deadline: number): Promise<number> {
    // 先讀全頁，再將按鈕限定於有正確票名與張數的選票畫面。
    checkRoute(page, context, true);
    const first = await snapshot(page, context, deadline);
    verifySelection(context, first);
    if (!first.nextEnabled) throw stop(context, "button-unavailable");
    const label = page.locator(
        `xpath=./div[contains(concat(' ', normalize-space(@class), ' '), ' font-weight-medium ')][text()[normalize-space(.)=${xpathLiteral(context.settings.target.ticketType.replace(/\s+/g, " "))}]]`,
    );
    const row = page
        .locator(".row.py-1.py-md-4.rwd-margin.no-gutters")
        .filter({ visible: true, has: label })
        .filter({
            has: page
                .locator(".count-button > div")
                .filter({ visible: true, hasText: new RegExp(`^\\s*${context.settings.target.quantity}\\s*$`) }),
        });
    const scope = page
        .locator("body")
        .filter({ has: row })
        .filter({ hasNot: page.getByText("聯絡人資訊", { exact: true }).filter({ visible: true }) })
        .filter({ hasNot: page.getByRole("heading", { level: 3, name: /排隊購票中/ }).filter({ visible: true }) });
    const locator = scope.getByRole("button", { name: "下一步", exact: true }).filter({ visible: true });
    if ((await readBounded(context, deadline, () => locator.count())) !== 1) throw stop(context, "button-unavailable");

    // 固定按鈕節點，換頁後不重新解析成資料頁的同名下一步。
    const button = await locator.elementHandle({
        timeout: Math.min(context.options.clickTimeoutMs, remaining(context, deadline)),
    });
    if (!button) throw stop(context, "button-unavailable");
    try {
        const latest = await snapshot(page, context, deadline);
        verifySelection(context, latest);
        checkRoute(page, context, true);
        if (
            !latest.nextEnabled ||
            !(await readBounded(context, deadline, () => button.isVisible())) ||
            !(await readBounded(context, deadline, () => button.isEnabled()))
        )
            throw stop(context, "button-unavailable");

        // 提交期限從嘗試前開始；點擊拋錯也消耗本次唯一額度。
        const started = performance.now();
        const waitDeadline = Math.min(context.deadline, started + context.options.submitWaitMs);
        const timeout = Math.min(
            context.options.clickTimeoutMs,
            remaining(context, deadline),
            remaining(context, waitDeadline),
        );
        context.progress.submitAttempted = true;
        context.diagnostic = { phase: "after-submit" };
        notifyProgress(context);
        try {
            await button.click({
                timeout: Math.min(timeout, remaining(context, deadline), remaining(context, waitDeadline)),
            });
        } catch {
            context.control.check();
            throw stop(context, "submit-click-failed");
        }
        context.control.check();
        return waitDeadline;
    } finally {
        await button.dispose().catch(() => {});
    }
}
function sameFailure(value: TicketPlusPage, expected: OrderFailurePage): value is OrderFailurePage {
    return (
        value.kind === "order-failure" &&
        value.messageKey === expected.messageKey &&
        value.failure === expected.failure &&
        value.dialogIndex === expected.dialogIndex &&
        value.dismissNames.length === 1 &&
        value.dismissNames[0] === expected.dismissNames[0]
    );
}
async function dismissFailure(page: Page, context: Submission, failure: OrderFailurePage): Promise<never> {
    // 確認失敗後結果不再轉為成功；關閉另有一次額度且受總期限限制。
    context.progress.failure = failure.failure;
    const deadline = Math.min(context.deadline, performance.now() + context.options.closeTimeoutMs);
    notifyProgress(context);
    checkRoute(page, context, true);
    if (failure.dismissNames.length !== 1) throw stop(context, "dismiss-unavailable");
    const candidates = page.locator('[role="dialog"], .v-dialog, .v-dialog__content');
    const dialog = await candidates.nth(failure.dialogIndex).elementHandle({ timeout: remaining(context, deadline) });
    if (!dialog) throw stop(context, "dismiss-changed");
    try {
        const latest = await snapshot(page, context, deadline);
        if (latest.kind === "ticket-selection" || latest.kind === "queue") {
            context.progress.dismissal = "disappeared";
            notifyProgress(context);
            throw stop(context, "order-rejected");
        }
        if (!sameFailure(latest, failure)) throw stop(context, "dismiss-changed");

        // 同一節點的完整內容只保存在瀏覽器內，避免換成另一個同名按鈕。
        const original = await readBounded(context, deadline, () =>
            dialog.evaluateHandle(element => ({
                element,
                text: (element as HTMLElement).innerText,
            })),
        );
        try {
            const locator = candidates
                .nth(failure.dialogIndex)
                .getByRole("button", { name: failure.dismissNames[0]!, exact: true })
                .filter({ visible: true });
            if ((await readBounded(context, deadline, () => locator.count())) !== 1)
                throw stop(context, "dismiss-unavailable");
            const button = await locator.elementHandle({ timeout: remaining(context, deadline) });
            if (!button) throw stop(context, "dismiss-unavailable");
            try {
                const current = await snapshot(page, context, deadline);
                if (!sameFailure(current, failure)) throw stop(context, "dismiss-changed");
                checkRoute(page, context, true);
                const unchanged = await readBounded(context, deadline, () =>
                    original.evaluate(
                        (saved, target) =>
                            saved.element.isConnected &&
                            saved.element.contains(target) &&
                            (saved.element as HTMLElement).innerText === saved.text,
                        button,
                    ),
                );
                if (!unchanged || !(await readBounded(context, deadline, () => button.isEnabled())))
                    throw stop(context, "dismiss-changed");

                context.progress.dismissal = "unconfirmed";
                const timeout = Math.min(context.options.clickTimeoutMs, remaining(context, deadline));
                context.progress.dismissAttempted = true;
                notifyProgress(context);
                await button.click({ timeout: Math.min(timeout, remaining(context, deadline)) });
            } finally {
                await button.dispose().catch(() => {});
            }
        } finally {
            await original.dispose().catch(() => {});
        }

        // 必須重新讀到無失敗／未知彈窗的同 order 頁；舊節點消失不夠。
        while (true) {
            checkRoute(page, context, true);
            const current = await snapshot(page, context, deadline);
            if (current.kind === "ticket-selection" || current.kind === "queue") {
                context.progress.dismissal = "confirmed";
                notifyProgress(context);
                throw stop(context, "order-rejected");
            }
            if (!sameFailure(current, failure)) throw stop(context, "dismiss-unconfirmed");
            await pause(context, deadline);
        }
    } finally {
        await dialog.dispose().catch(() => {});
    }
}
async function pause(context: Submission, deadline: number): Promise<void> {
    await context.control.wait(Math.min(context.options.pollIntervalMs, remaining(context, deadline)));
}
async function waitForInformation(page: Page, context: Submission, initialDeadline: number): Promise<InformationPage> {
    let deadline = initialDeadline;
    while (true) {
        const value = await snapshot(page, context, deadline, true);
        if (value.kind === "order-failure") return dismissFailure(page, context, value);
        if (value.kind === "information") return value;

        // 排隊期限只建立一次，消失後再出現仍沿用原期限。
        if (value.kind === "queue") {
            if (!context.progress.sawQueue) {
                context.progress.sawQueue = true;
                deadline = Math.min(context.deadline, performance.now() + context.options.queueWaitMs);
                notifyProgress(context);
            }
        } else if (value.kind === "ticket-selection") {
            verifySelection(context, value);
        } else if (
            value.kind !== "unknown" ||
            !["incomplete-data", "page-changed", "read-failed", "selection-transition"].includes(value.reason)
        ) {
            throw stop(context, "unexpected-page");
        }
        await pause(context, deadline);
    }
}

// 單次呼叫最多一次提交及一次關閉；不刷新、不恢復、不保證跨呼叫防重送。
export async function submitTicketPlusSelection(
    page: Page,
    input: TicketPlusSelection,
    selection: TicketSelectionPage,
    options: TicketSubmissionOptions = {},
    observer?: SubmissionObserver,
    control = new TicketPlusRunControl(),
): Promise<InformationPage> {
    let context: Submission | undefined;
    try {
        // 複製設定與上一步快照，先拒絕不一致的輸入，不碰瀏覽器。
        control.check();
        const settings = parseTicketPlusSelection(input);
        const selected = structuredClone(selection);
        const resolved = { ...defaults, ...options };
        if (!Object.values(resolved).every(value => Number.isFinite(value) && value > 0 && value <= 2_147_483_647)) {
            throw new TicketPlusSubmissionError("invalid-options", emptySubmissionProgress());
        }
        context = {
            control,
            settings,
            selected,
            options: resolved,
            deadline: performance.now() + resolved.totalTimeoutMs,
            progress: emptySubmissionProgress(),
            observer,
        };
        if (
            selected.eventId !== new URL(settings.eventUrl).pathname.split("/")[2] ||
            typeof selected.sessionId !== "string" ||
            !/^[A-Za-z0-9_-]+$/.test(selected.sessionId)
        ) {
            throw stop(context, "invalid-input");
        }
        verifySelection(context, selected);

        // 前置核對有獨立期限；提交後只進入唯讀等待或單次關閉。
        const deadline = Math.min(context.deadline, performance.now() + resolved.preflightTimeoutMs);
        const initialDeadline = await submitOnce(page, context, deadline);
        return await waitForInformation(page, context, initialDeadline);
    } catch (error) {
        let stopError = error instanceof TicketPlusStopError ? error : undefined;
        if (!stopError) {
            try {
                control.check();
            } catch (caught) {
                if (caught instanceof TicketPlusStopError) stopError = caught;
            }
        }
        if (stopError) {
            throw new TicketPlusSubmissionError(
                stopError.stopReason === "time-limit" ? "time-limit" : "user-stopped",
                { ...(context?.progress ?? emptySubmissionProgress()) },
                stopError.stopReason,
                context?.diagnostic,
            );
        }
        if (error instanceof TicketPlusSubmissionError) throw error;
        if (context) throw stop(context, context.progress.failure ? "dismiss-unconfirmed" : "read-failed");
        throw new TicketPlusSubmissionError("invalid-input", emptySubmissionProgress());
    }
}
