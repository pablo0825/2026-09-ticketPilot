interface SummaryField {
    label: string;
    value: string;
    href?: string;
}

export interface PurchaseSummaryData {
    fields: SummaryField[];
    columns: { label: string; wrap?: boolean }[];
    rows: (string | number)[][];
    notes: SummaryField[];
}
