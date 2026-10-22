import { secondaryButton, fieldLabel, fieldInput } from "../../shared/styles.js";
import type { TargetDraft } from "./formModel.js";
import type { TargetRowActions } from "../../pages/targetRowActions.js";

interface Props extends TargetRowActions {
    target: TargetDraft;
    index: number;
    disabled: boolean;
    only: boolean;
    first: boolean;
    last: boolean;
    bundleEnabled: boolean;
    onChange: (patch: Partial<TargetDraft>) => void;
}

export function KlookTargetRow({
    target,
    index,
    disabled,
    only,
    first,
    last,
    bundleEnabled,
    onChange,
    onMoveUp,
    onMoveDown,
    onRemove,
    onDuplicate,
}: Props) {
    return (
        <div
            className="target-row my-4 space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4"
            role="group"
            aria-label={`順位 ${index + 1}`}
        >
            <h3 className="position text-base font-semibold">順位 {index + 1}</h3>
            <div className="target-fields grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                    票區／票種
                    <input
                        className={fieldInput}
                        name="area"
                        required
                        disabled={disabled}
                        value={target.area}
                        onChange={e => onChange({ area: e.target.value })}
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
                        onChange={e =>
                            onChange({
                                quantity: e.target.value,
                                adjacent: Number(e.target.value) <= 1 ? false : target.adjacent,
                            })
                        }
                    />
                </label>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className={`bundle-field lg:col-span-3 ${fieldLabel}`} hidden={!bundleEnabled}>
                    組合套票
                    <input
                        className={fieldInput}
                        name="bundle"
                        required={bundleEnabled}
                        disabled={disabled || !bundleEnabled}
                        value={target.bundle}
                        onChange={e => onChange({ bundle: e.target.value })}
                        placeholder="例如：演唱會套票 1"
                    />
                </label>
                <fieldset className="min-w-0">
                    <legend className="mb-2 text-sm">要求連位</legend>
                    <label className="check flex h-[38px] items-center gap-2 text-sm">
                        <input
                            className="size-4 shrink-0 accent-blue-600"
                            name="adjacent"
                            type="checkbox"
                            disabled={disabled || Number(target.quantity) <= 1}
                            checked={target.adjacent}
                            onChange={e => onChange({ adjacent: e.target.checked })}
                        />
                        啟用
                    </label>
                </fieldset>
            </div>
            <div className="target-tools flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className={`${secondaryButton} up`}
                    disabled={disabled || first}
                    onClick={onMoveUp}
                >
                    上移
                </button>
                <button
                    type="button"
                    className={`${secondaryButton} down`}
                    disabled={disabled || last}
                    onClick={onMoveDown}
                >
                    下移
                </button>
                <button type="button" className={`${secondaryButton} remove`} disabled={disabled} onClick={onRemove}>
                    {only ? "清空" : "移除"}
                </button>
                <button
                    type="button"
                    className={`${secondaryButton} duplicate`}
                    disabled={disabled}
                    onClick={onDuplicate}
                >
                    複製
                </button>
            </div>
        </div>
    );
}
