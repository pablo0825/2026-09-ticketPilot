import type { ActivityForm } from "./formModel.js";

interface Props {
    flowType: ActivityForm["flowType"];
    disabled: boolean;
    onChange: (value: ActivityForm["flowType"]) => void;
}

export function TicketPlusActivitySettings({ flowType, disabled, onChange }: Props) {
    return (
        <fieldset className="feature-settings min-w-0 space-y-2" disabled={disabled}>
            <legend className="mb-2 text-sm font-medium">購票流程</legend>
            <label className="check flex items-center gap-2 text-sm">
                <input
                    className="size-4 shrink-0 accent-blue-600"
                    id="flowPurchase"
                    type="radio"
                    name="flowType"
                    checked={flowType === "purchase"}
                    onChange={() => onChange("purchase")}
                />
                購票
            </label>
            <label className="check flex items-center gap-2 text-sm">
                <input
                    className="size-4 shrink-0 accent-blue-600"
                    id="flowLottery"
                    type="radio"
                    name="flowType"
                    checked={flowType === "lottery"}
                    onChange={() => onChange("lottery")}
                />
                登記抽選
            </label>
        </fieldset>
    );
}
