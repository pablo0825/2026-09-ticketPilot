import { primaryButton, secondaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import { emptyTarget as emptyTicketPlusTarget } from "../platforms/ticketplus/formModel.js";
import type { ActivityForm as TicketPlusForm } from "../platforms/ticketplus/formModel.js";
import { emptyTarget as emptyKlookTarget } from "../platforms/klook/formModel.js";
import type { ActivityForm as KlookForm } from "../platforms/klook/formModel.js";
import type { TicketPlusActivitySettings } from "../../../config/ticketPlusActivity.js";
import { TicketPlusTargetRow } from "../platforms/ticketplus/TicketPlusTargetRow.js";
import { KlookTargetRow } from "../platforms/klook/KlookTargetRow.js";
import { targetRowActions } from "./targetRowActions.js";

interface CommonProps {
    disabled: boolean;
    attached?: boolean;
    onSave: () => void;
}
type Props = CommonProps &
    (
        | { platform: "klook"; form: KlookForm; title: string; onChange: (form: KlookForm) => void }
        | {
              platform?: "ticketplus";
              form: TicketPlusForm;
              saved?: TicketPlusActivitySettings;
              onChange: (form: TicketPlusForm) => void;
          }
    );

export function ActivityEditorPage(props: Props) {
    const { form, disabled, attached = true, onSave } = props;
    const isKlook = props.platform === "klook";
    const sessions = new Set(
        form.targets.filter(target => target.date && target.time).map(target => `${target.date} ${target.time}`),
    );
    function changeCommon(patch: Partial<Pick<TicketPlusForm, "eventName" | "eventUrl">>) {
        if (props.platform === "klook") props.onChange({ ...props.form, ...patch });
        else props.onChange({ ...props.form, ...patch });
    }
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
                {props.platform === "klook" ? props.title : props.saved ? "編輯活動" : "新增活動"}
            </h2>
            <label className={fieldLabel}>
                活動名稱
                <input
                    className={fieldInput}
                    id="eventName"
                    required
                    disabled={disabled}
                    value={form.eventName}
                    onChange={e => changeCommon({ eventName: e.target.value })}
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
                    value={form.eventUrl}
                    onChange={e => changeCommon({ eventUrl: e.target.value })}
                    placeholder={
                        isKlook ? "https://www.klook.com/zh-TW/event-detail/…/" : "https://ticketplus.com.tw/activity/…"
                    }
                />
            </label>
            {props.platform === "klook" ? (
                <>
                    <fieldset className="feature-settings min-w-0 space-y-2" disabled={disabled}>
                        <legend className="mb-2 text-sm font-medium">功能啟用</legend>
                        <label className="check flex items-center gap-2 text-sm">
                            <input
                                className="size-4 shrink-0 accent-blue-600"
                                id="queueEnabled"
                                type="checkbox"
                                checked={props.form.queueEnabled}
                                onChange={e => props.onChange({ ...props.form, queueEnabled: e.target.checked })}
                            />
                            排隊流程
                        </label>
                        <label className="check flex items-center gap-2 text-sm">
                            <input
                                className="size-4 shrink-0 accent-blue-600"
                                id="bundleEnabled"
                                type="checkbox"
                                checked={props.form.bundleEnabled}
                                onChange={e =>
                                    props.onChange(
                                        e.target.checked
                                            ? { ...props.form, bundleEnabled: true }
                                            : {
                                                  ...props.form,
                                                  bundleEnabled: false,
                                                  deliveryMethod: "",
                                                  targets: props.form.targets.map(target => ({
                                                      ...target,
                                                      bundle: "",
                                                  })),
                                              },
                                    )
                                }
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
                                disabled={disabled || !props.form.bundleEnabled}
                                value={props.form.deliveryMethod}
                                onChange={e => props.onChange({ ...props.form, deliveryMethod: e.target.value })}
                                placeholder="例如：指定地點自取"
                            />
                        </label>
                        <div
                            id="legacyDelivery"
                            className="space-y-2"
                            hidden={props.form.bundleEnabled || !props.form.deliveryMethod.trim()}
                        >
                            <p>
                                此活動有未啟用套票的舊取票設定。請啟用套票並補齊各順位，或清除舊取票設定後再儲存及開始。
                            </p>
                            <button
                                type="button"
                                id="clearLegacyDelivery"
                                className={secondaryButton}
                                disabled={disabled}
                                onClick={() => props.onChange({ ...props.form, deliveryMethod: "" })}
                            >
                                清除舊取票設定
                            </button>
                        </div>
                    </div>
                </>
            ) : (
                <fieldset className="feature-settings min-w-0 space-y-2" disabled={disabled}>
                    <legend className="mb-2 text-sm font-medium">購票流程</legend>
                    <label className="check flex items-center gap-2 text-sm">
                        <input
                            className="size-4 shrink-0 accent-blue-600"
                            id="flowPurchase"
                            type="radio"
                            name="flowType"
                            checked={props.form.flowType === "purchase"}
                            onChange={() => props.onChange({ ...props.form, flowType: "purchase" })}
                        />
                        購票
                    </label>
                    <label className="check flex items-center gap-2 text-sm">
                        <input
                            className="size-4 shrink-0 accent-blue-600"
                            id="flowLottery"
                            type="radio"
                            name="flowType"
                            checked={props.form.flowType === "lottery"}
                            onChange={() => props.onChange({ ...props.form, flowType: "lottery" })}
                        />
                        登記抽選
                    </label>
                </fieldset>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold">購票順位</h2>
                </div>
                <button type="button" id="add" className={secondaryButton} disabled={disabled} onClick={addTarget}>
                    新增順位
                </button>
            </div>
            {!isKlook && sessions.size > 1 && <p role="status">此設定含不同場次，可以儲存，但目前無法啟動購票。</p>}
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
            {props.platform === "klook" && (
                <details>
                    <summary className="cursor-pointer">進階設定</summary>
                    <label className={fieldLabel}>
                        <span className="text-sm font-medium">排除關鍵字（以逗號分隔）</span>
                        <input
                            className={fieldInput}
                            id="exclude"
                            disabled={disabled}
                            value={props.form.exclude}
                            onChange={e => props.onChange({ ...props.form, exclude: e.target.value })}
                        />
                    </label>
                </details>
            )}
            <footer className="flex justify-end">
                <button
                    className={primaryButton}
                    id="saveActivity"
                    type={isKlook ? "button" : "submit"}
                    disabled={disabled}
                    onClick={isKlook ? onSave : undefined}
                >
                    下一步
                </button>
            </footer>
        </>
    );

    const className = `${attached ? stepPanel : panel} space-y-5`;
    // Klook 保留按鈕保存的驗證入口，不因共用頁面新增 Enter 提交或原生表單攔截。
    return isKlook ? (
        <div data-tailwind className={className}>
            {content}
        </div>
    ) : (
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
