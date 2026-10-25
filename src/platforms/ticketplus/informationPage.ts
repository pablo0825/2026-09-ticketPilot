import type { TicketPlusDom } from "./domSnapshot.js";
import { single, unknownPage } from "./readResult.js";
import type { PageIdentity, UnknownPage } from "./readResult.js";

export interface ContactFieldState {
    present: boolean;
    hasValue: boolean;
    disabled: boolean;
}

export interface InformationPage extends PageIdentity {
    kind: "information";
    contactFields: { name: ContactFieldState; phone: ContactFieldState; email: ContactFieldState };
    termsChecked: boolean;
    nextEnabled: boolean;
}

export function parseInformationPage(dom: TicketPlusDom, identity: PageIdentity): InformationPage | UnknownPage {
    // 只回報欄位狀態，不把有值當作已核對聯絡人身分。
    const data = dom.information;
    if (
        data.headingCount > 1 ||
        data.terms.length > 1 ||
        data.contact.some(fields => fields.length > 1) ||
        dom.nextButtons.length > 1
    ) {
        return unknownPage("ambiguous-data");
    }

    const termsChecked = single(data.terms);
    const nextEnabled = single(dom.nextButtons);
    if (data.headingCount !== 1 || termsChecked === undefined || nextEnabled === undefined)
        return unknownPage("incomplete-data");

    // 缺欄位仍明確標記 present=false，後續流程必須自行驗證。
    const fields = data.contact.map(values => {
        const field = single(values);
        return field ? { present: true, ...field } : { present: false, hasValue: false, disabled: false };
    });

    return {
        kind: "information",
        ...identity,
        contactFields: { name: fields[0]!, phone: fields[1]!, email: fields[2]! },
        termsChecked,
        nextEnabled,
    };
}
