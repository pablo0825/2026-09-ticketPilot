import { Fragment } from "react";
import type { ReactNode } from "react";
import { primaryButton, secondaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import { targetRowActions } from "./targetRowActions.js";
import type { TargetRowActions } from "./targetRowActions.js";

interface TargetRowProps<T> extends TargetRowActions {
    target: T;
    index: number;
    disabled: boolean;
    first: boolean;
    last: boolean;
    only: boolean;
    onChange: (patch: Partial<T>) => void;
}

interface Props<T> {
    title: string;
    eventName: string;
    eventUrl: string;
    eventUrlPlaceholder: string;
    onCommonChange: (patch: Partial<{ eventName: string; eventUrl: string }>) => void;
    platformSettings: ReactNode;
    advancedSettings?: ReactNode;
    targetNotice?: ReactNode;
    disabled: boolean;
    attached?: boolean;
    onSave: () => void;
    targets: T[];
    onTargetsChange: (targets: T[]) => void;
    createTarget: () => T;
    duplicateTarget: (target: T) => T;
    renderTargetRow: (props: TargetRowProps<T>) => ReactNode;
}
export function ActivityEditorPage<T extends { key: string }>(props: Props<T>) {
    const { disabled, attached = true, onSave, targets, onTargetsChange, createTarget, duplicateTarget } = props;
    function addTarget() {
        onTargetsChange([...targets, createTarget()]);
    }

    const content = (
        <>
            <h2 id="editorTitle" className="text-xl font-semibold">
                {props.title}
            </h2>
            <label className={fieldLabel}>
                活動名稱
                <input
                    className={fieldInput}
                    id="eventName"
                    required
                    disabled={disabled}
                    value={props.eventName}
                    onChange={e => props.onCommonChange({ eventName: e.target.value })}
                    placeholder="輸入官網活動完整名稱"
                />
            </label>
            <label className={fieldLabel}>
                活動網址
                <input
                    className={fieldInput}
                    id="eventUrl"
                    type="url"
                    required
                    disabled={disabled}
                    value={props.eventUrl}
                    onChange={e => props.onCommonChange({ eventUrl: e.target.value })}
                    placeholder={props.eventUrlPlaceholder}
                />
            </label>
            {props.platformSettings}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold">購票順位</h2>
                </div>
                <button type="button" id="add" className={secondaryButton} disabled={disabled} onClick={addTarget}>
                    新增順位
                </button>
            </div>
            {props.targetNotice}
            <div id="targets">
                {targets.map((target, index) => (
                    <Fragment key={target.key}>
                        {props.renderTargetRow({
                            target,
                            index,
                            disabled,
                            only: targets.length === 1,
                            first: index === 0,
                            last: index === targets.length - 1,
                            onChange: patch =>
                                onTargetsChange(targets.map((row, i) => (i === index ? { ...row, ...patch } : row))),
                            ...targetRowActions(targets, index, onTargetsChange, createTarget, duplicateTarget),
                        })}
                    </Fragment>
                ))}
            </div>
            {props.advancedSettings}
            <footer className="flex justify-end">
                <button className={primaryButton} id="saveActivity" type="submit" disabled={disabled}>
                    下一步
                </button>
            </footer>
        </>
    );

    const className = `${attached ? stepPanel : panel} space-y-5`;
    return (
        <form
            data-tailwind
            className={className}
            onSubmit={event => {
                event.preventDefault();
                onSave();
            }}
        >
            {content}
        </form>
    );
}
