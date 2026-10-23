import type { ReactNode } from "react";
import { primaryButton, secondaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import { emptyTarget as emptyTicketPlusTarget } from "../platforms/ticketplus/formModel.js";
import type { ActivityForm as TicketPlusForm } from "../platforms/ticketplus/formModel.js";
import { emptyTarget as emptyKlookTarget } from "../platforms/klook/formModel.js";
import type { ActivityForm as KlookForm } from "../platforms/klook/formModel.js";
import { TicketPlusTargetRow } from "../platforms/ticketplus/TicketPlusTargetRow.js";
import { KlookTargetRow } from "../platforms/klook/KlookTargetRow.js";
import { targetRowActions } from "./targetRowActions.js";

interface CommonProps {
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
}
type Props = CommonProps &
    (
        | { platform: "klook"; form: KlookForm; onChange: (form: KlookForm) => void }
        | {
              platform?: "ticketplus";
              form: TicketPlusForm;
              onChange: (form: TicketPlusForm) => void;
          }
    );

export function ActivityEditorPage(props: Props) {
    const { disabled, attached = true, onSave } = props;
    function addTarget() {
        if (props.platform === "klook") {
            props.onChange({ ...props.form, targets: [...props.form.targets, emptyKlookTarget()] });
        } else {
            props.onChange({ ...props.form, targets: [...props.form.targets, emptyTicketPlusTarget()] });
        }
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
                {props.platform === "klook"
                    ? props.form.targets.map((target, index) => (
                          <KlookTargetRow
                              key={target.key}
                              target={target}
                              index={index}
                              disabled={disabled}
                              only={props.form.targets.length === 1}
                              first={index === 0}
                              last={index === props.form.targets.length - 1}
                              bundleEnabled={props.form.bundleEnabled}
                              onChange={patch =>
                                  props.onChange({
                                      ...props.form,
                                      targets: props.form.targets.map((row, i) =>
                                          i === index ? { ...row, ...patch } : row,
                                      ),
                                  })
                              }
                              {...targetRowActions(
                                  props.form.targets,
                                  index,
                                  targets => props.onChange({ ...props.form, targets }),
                                  emptyKlookTarget,
                                  row => ({ ...row, key: crypto.randomUUID(), bundle: row.bundle.trim() }),
                              )}
                          />
                      ))
                    : props.form.targets.map((target, index) => (
                          <TicketPlusTargetRow
                              key={target.key}
                              target={target}
                              index={index}
                              disabled={disabled}
                              only={props.form.targets.length === 1}
                              first={index === 0}
                              last={index === props.form.targets.length - 1}
                              onChange={patch =>
                                  props.onChange({
                                      ...props.form,
                                      targets: props.form.targets.map((row, i) =>
                                          i === index ? { ...row, ...patch } : row,
                                      ),
                                  })
                              }
                              {...targetRowActions(
                                  props.form.targets,
                                  index,
                                  targets => props.onChange({ ...props.form, targets }),
                                  emptyTicketPlusTarget,
                                  row => ({ ...row, key: crypto.randomUUID() }),
                              )}
                          />
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
