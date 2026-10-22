import { Fragment } from "react";

interface BreadcrumbItem {
    label: string;
    id?: string;
    actionLabel?: string;
    onSelect?: () => void;
}
interface Props {
    items: BreadcrumbItem[];
    disabled: boolean;
    lockReason?: string;
}

export function Breadcrumbs({ items, disabled, lockReason }: Props) {
    return (
        <nav
            data-tailwind
            className="breadcrumb relative mb-6 flex min-w-0 items-center gap-2 text-sm text-slate-600"
            aria-label="目前位置"
        >
            {items.map((item, index) => (
                <Fragment key={`${index}-${item.label}`}>
                    {index > 0 && <span aria-hidden="true">/</span>}
                    {item.onSelect ? (
                        <button
                            type="button"
                            id={item.id}
                            aria-label={item.actionLabel}
                            disabled={disabled}
                            onClick={item.onSelect}
                            className="shrink-0 rounded bg-transparent p-0 font-semibold text-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:opacity-50"
                        >
                            {item.label}
                        </button>
                    ) : (
                        <span
                            className="breadcrumb-current min-w-0 truncate text-slate-800"
                            aria-current="page"
                            title={item.label}
                        >
                            {item.label}
                        </span>
                    )}
                </Fragment>
            ))}
            {lockReason && (
                <span
                    className="lock-chip group static shrink-0 rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-blue-600 md:relative"
                    role="note"
                    tabIndex={0}
                >
                    <span aria-hidden="true">🔒 </span>設定已鎖定
                    <span className="sr-only">：</span>
                    <span className="lock-chip-tip sr-only group-hover:not-sr-only group-focus-visible:not-sr-only group-hover:absolute group-focus-visible:absolute top-full left-0 right-0 z-10 rounded-lg bg-slate-800 text-white shadow-md group-hover:mt-1 group-focus-visible:mt-1 group-hover:p-3 group-focus-visible:p-3 md:right-auto md:group-hover:w-max md:group-focus-visible:w-max md:max-w-sm before:absolute before:inset-x-0 before:bottom-full before:h-2 before:content-['']">
                        {lockReason}
                    </span>
                </span>
            )}
        </nav>
    );
}
