import { fieldInput, fieldLabel, secondaryButton } from "../../shared/styles.js";
import type { ActivityForm } from "./formModel.js";

interface Props {
    form: Pick<ActivityForm, "queueEnabled" | "bundleEnabled" | "deliveryMethod">;
    disabled: boolean;
    onQueueChange: (enabled: boolean) => void;
    onBundleChange: (enabled: boolean) => void;
    onDeliveryChange: (value: string) => void;
}

export function KlookActivitySettings({ form, disabled, onQueueChange, onBundleChange, onDeliveryChange }: Props) {
    return (
        <>
            <fieldset className="feature-settings min-w-0 space-y-2" disabled={disabled}>
                <legend className="mb-2 text-sm">功能啟用</legend>
                <label className="check flex items-center gap-2 text-sm">
                    <input
                        className="size-4 shrink-0 accent-blue-600"
                        id="queueEnabled"
                        type="checkbox"
                        checked={form.queueEnabled}
                        onChange={e => onQueueChange(e.target.checked)}
                    />
                    排隊流程
                </label>
                <label className="check flex items-center gap-2 text-sm">
                    <input
                        className="size-4 shrink-0 accent-blue-600"
                        id="bundleEnabled"
                        type="checkbox"
                        checked={form.bundleEnabled}
                        onChange={e => onBundleChange(e.target.checked)}
                    />
                    組合套票
                </label>
            </fieldset>
            <div id="bundleSettings" className="space-y-3">
                <label className={fieldLabel}>
                    取票方式（選填）
                    <input
                        className={fieldInput}
                        id="deliveryMethod"
                        disabled={disabled || !form.bundleEnabled}
                        value={form.deliveryMethod}
                        onChange={e => onDeliveryChange(e.target.value)}
                        placeholder="例如：指定地點自取"
                    />
                </label>
                <div
                    id="legacyDelivery"
                    className="space-y-2"
                    hidden={form.bundleEnabled || !form.deliveryMethod.trim()}
                >
                    <p>此活動有未啟用套票的舊取票設定。請啟用套票並補齊各順位，或清除舊取票設定後再儲存及開始。</p>
                    <button
                        type="button"
                        id="clearLegacyDelivery"
                        className={secondaryButton}
                        disabled={disabled}
                        onClick={() => onDeliveryChange("")}
                    >
                        清除舊取票設定
                    </button>
                </div>
            </div>
        </>
    );
}

export function KlookAdvancedSettings({
    exclude,
    disabled,
    onChange,
}: {
    exclude: string;
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    return (
        <details>
            <summary className="cursor-pointer">進階設定</summary>
            <label className={`mt-3 ${fieldLabel}`}>
                排除關鍵字（以逗號分隔）
                <input
                    className={fieldInput}
                    id="exclude"
                    disabled={disabled}
                    value={exclude}
                    onChange={e => onChange(e.target.value)}
                />
            </label>
        </details>
    );
}
