import { TicketPlusRunControl } from "./runControl.js";
import type { Page } from "playwright";
import { parseTicketPlusActivity, ticketPlusSessionSelection } from "../../config/ticketPlusActivity.js";
import type { TicketPlusActivitySettings, TicketPlusSelection } from "../../config/ticketPlusActivity.js";
import { expandTicketPlusArea } from "./areaExpansion.js";
import { readTicketPlusPage } from "./pageState.js";
import { selectTicketPlusTickets } from "./ticketQuantity.js";
import type { TicketQuantityOptions, VerifiedTicketPlusSession } from "./ticketQuantity.js";
import { findTargetTickets } from "./ticketSelectionPage.js";
import type { TicketSelectionPage } from "./ticketSelectionPage.js";

export type PriorityReason =
    | "invalid-options"
    | "unexpected-page"
    | "identity-mismatch"
    | "ticket-missing"
    | "ticket-ambiguous"
    | "extra-tickets"
    // 所有目標都已售完或暫無票券；沿用原名稱以相容既有紀錄與更新流程。
    | "all-targets-sold-out"
    // 目標票區收合，點擊展開後沒有在期限內出現唯一的票種列；不重點。
    | "area-expansion-failed"
    | "operation-timeout";
export class TicketPlusPriorityError extends Error {
    constructor(public readonly reason: PriorityReason) {
        super(`TicketPlus 順位選擇停止（${reason}）。`);
    }
}

export interface TicketPriorityOptions extends TicketQuantityOptions {
    startPriorityIndex?: number;
}

// 挑選候選只讀取；唯一的點擊是交給展開模組展開收合的目標票區。
// 所有張數操作只交給單目標模組一次，錯誤不能變成換順位。
export async function selectTicketPlusPriority(
    page: Page,
    input: TicketPlusActivitySettings,
    session: VerifiedTicketPlusSession,
    options: TicketPriorityOptions = {},
    control = new TicketPlusRunControl(),
): Promise<{ selection: TicketPlusSelection; snapshot: TicketSelectionPage; priorityIndex: number }> {
    // 複製設定並確認同場次；挑選與調張數共用一個期限。
    control.check();
    const settings = parseTicketPlusActivity(input);
    const first = ticketPlusSessionSelection(settings);
    const start = options.startPriorityIndex ?? 0;
    if (!Number.isInteger(start) || start < 0 || start >= settings.targets.length) {
        throw new TicketPlusPriorityError("invalid-options");
    }
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647) throw new Error("無效的選票期限。");
    const deadline = performance.now() + timeout;
    const identity = { ...session };
    if (
        identity.eventId !== new URL(first.eventUrl).pathname.split("/")[2] ||
        identity.eventName !== first.eventName ||
        identity.date !== first.target.date ||
        identity.time !== first.target.time ||
        !/^[A-Za-z0-9_-]+$/.test(identity.sessionId)
    ) {
        throw new TicketPlusPriorityError("identity-mismatch");
    }
    const remaining = () => {
        control.check();
        const value = deadline - performance.now();
        if (value <= 0) throw new TicketPlusPriorityError("operation-timeout");
        return value;
    };

    // 讀完整選票頁並核對同場次；讀取受同一期限限制。
    const readCurrentPage = async (): Promise<TicketSelectionPage> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let snapshot;
        try {
            snapshot = await control.read(() =>
                Promise.race([
                    readTicketPlusPage(page),
                    new Promise<never>((_, reject) => {
                        timer = setTimeout(() => reject(new TicketPlusPriorityError("operation-timeout")), remaining());
                    }),
                ]),
            );
        } finally {
            clearTimeout(timer);
        }
        remaining();
        if (snapshot.kind !== "ticket-selection") throw new TicketPlusPriorityError("unexpected-page");
        if (
            snapshot.eventId !== identity.eventId ||
            snapshot.sessionId !== identity.sessionId ||
            snapshot.eventName !== identity.eventName ||
            snapshot.date !== identity.date ||
            snapshot.time !== identity.time
        ) {
            throw new TicketPlusPriorityError("identity-mismatch");
        }
        return snapshot;
    };

    // 每個順位重新讀完整頁面；只有唯一且明確售完或暫無票券的票種能被略過。
    for (let priorityIndex = start; priorityIndex < settings.targets.length; priorityIndex++) {
        const target = settings.targets[priorityIndex]!;
        let snapshot = await readCurrentPage();

        // 票區面板版型：目標票區收合時先展開（每次輪到此順位最多點一次），再重新讀取。
        const area = snapshot.areas.find(value => value.name === target.ticketType);
        if (area && !area.expanded) {
            const expansion = await expandTicketPlusArea(page, area.name, deadline, control);
            if (expansion === "ambiguous") throw new TicketPlusPriorityError("ticket-ambiguous");
            if (expansion === "unexpected-page") throw new TicketPlusPriorityError("unexpected-page");
            if (expansion === "not-expanded") {
                // 共用期限已到時回報 operation-timeout，與其他步驟一致。
                remaining();
                throw new TicketPlusPriorityError("area-expansion-failed");
            }
            snapshot = await readCurrentPage();
        }

        const matches = findTargetTickets(snapshot.tickets, target.ticketType);
        if (matches.length === 0) throw new TicketPlusPriorityError("ticket-missing");
        if (matches.length !== 1) throw new TicketPlusPriorityError("ticket-ambiguous");
        const ticket = matches[0]!;
        // 售完或暫無票券（他人保留中）都不能購買，跳下一順位；暫無票券不記為售完。
        const closed = ticket.saleStatus !== "selling";
        if (
            snapshot.tickets.some(
                other => other.selectedQuantity !== 0 && (priorityIndex > 0 || closed || other !== ticket),
            )
        ) {
            throw new TicketPlusPriorityError("extra-tickets");
        }
        if (closed) continue;

        // 選定後不得候補；略過售完或暫無票券順位後，調張數的首次讀取也必須保持零張。
        const selection = { ...first, target };
        const selected = await selectTicketPlusTickets(
            page,
            selection,
            identity,
            {
                ...options,
                timeoutMs: remaining(),
                requireZeroInitialQuantity: priorityIndex > 0 || options.requireZeroInitialQuantity,
            },
            control,
        );
        return { selection, snapshot: selected, priorityIndex };
    }
    throw new TicketPlusPriorityError("all-targets-sold-out");
}
