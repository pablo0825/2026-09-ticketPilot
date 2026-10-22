import { secondaryButton, fieldLabel, fieldInput } from "../../shared/styles.js";
import type { TargetDraft } from "./formModel.js";
import type { TargetRowActions } from "../../pages/targetRowActions.js";

interface Props extends TargetRowActions {
    target: TargetDraft;
    index: number;
    disabled: boolean;
    first: boolean;
    last: boolean;
    only: boolean;
    onChange: (patch: Partial<TargetDraft>) => void;
}

export function TicketPlusTargetRow({
    target,
    index,
    disabled,
    first,
    last,
    only,
    onChange,
    onMoveUp,
    onMoveDown,
    onRemove,
    onDuplicate,
}: Props) {
    return (
        <div
            className="my-4 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4"
            role="group"
            aria-label={`順位 ${index + 1}`}
        >
            <h3 className="text-base font-semibold">順位 {index + 1}</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className={fieldLabel}>
                    演出日期
                    <input
                        className={fieldInput}
                        name="date"
                        type="date"
                        required
                        disabled={disabled}
                        value={target.date}
                        onChange={e => onChange({ date: e.target.value })}
                    />
                </label>
                <label className={fieldLabel}>
                    演出時間
                    <input
                        className={fieldInput}
                        name="time"
                        type="time"
                        required
                        disabled={disabled}
                        value={target.time}
                        onChange={e => onChange({ time: e.target.value })}
                    />
                </label>
                <label className={fieldLabel}>
                    票種名稱
                    <input
                        className={fieldInput}
                        name="ticketType"
                        required
                        disabled={disabled}
                        value={target.ticketType}
                        onChange={e => onChange({ ticketType: e.target.value })}
                        placeholder="例如：預售票"
                    />
                </label>
                <label className={fieldLabel}>
                    張數
                    <input
                        className={fieldInput}
                        name="quantity"
                        type="number"
                        min="1"
                        step="1"
                        required
                        disabled={disabled}
                        value={target.quantity}
                        onChange={e => onChange({ quantity: e.target.value })}
                    />
                </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={secondaryButton} disabled={disabled || first} onClick={onMoveUp}>
                    上移
                </button>
                <button type="button" className={secondaryButton} disabled={disabled || last} onClick={onMoveDown}>
                    下移
                </button>
                <button type="button" className={secondaryButton} disabled={disabled} onClick={onRemove}>
                    {only ? "清空" : "移除"}
                </button>
                <button type="button" className={secondaryButton} disabled={disabled} onClick={onDuplicate}>
                    複製
                </button>
            </div>
        </div>
    );
}
