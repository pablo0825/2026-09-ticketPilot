import type { TicketPlusDom } from "./domSnapshot.js";
import { quantity, readEventDetails, single, unknownPage } from "./readResult.js";
import type { EventDetails, PageIdentity, UnknownPage } from "./readResult.js";

export interface CheckoutPage extends PageIdentity, EventDetails {
    kind: "checkout";
    tickets: { name: string; quantity: number }[];
    paymentEnabled: boolean;
}

export function parseCheckoutPage(dom: TicketPlusDom, identity: PageIdentity): CheckoutPage | UnknownPage {
    // 付款網址、步驟標記與摘要皆須存在，不能只看付款按鈕。
    const event = readEventDetails(dom);
    const paymentEnabled = single(dom.paymentButtons);
    if (!event || dom.checkoutStepCount !== 1 || paymentEnabled === undefined || dom.checkout.length === 0) {
        return unknownPage("incomplete-data");
    }

    // 每列固定為票種、數量、票價、小計；不略過未知或多出的票種列。
    const tickets: CheckoutPage["tickets"] = [];
    for (const columns of dom.checkout) {
        const [name, count] = columns;
        const value = count === undefined ? undefined : quantity(count);
        if (columns.length !== 4 || !name || value === undefined || value === 0 || !columns[2] || !columns[3]) {
            return unknownPage("incomplete-data");
        }
        tickets.push({ name, quantity: value });
    }
    return { kind: "checkout", ...identity, ...event, tickets, paymentEnabled };
}
