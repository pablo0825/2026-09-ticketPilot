import { primaryButton, panel, stepPanel, fieldLabel, fieldInput } from "../shared/styles.js";
import type { ContactDetails } from "../../../config/contact.config.js";

const regions = [
    "台灣 (+886)",
    "香港 (+852)",
    "澳門 (+853)",
    "中國 (+86)",
    "日本 (+81)",
    "韓國 (+82)",
    "新加坡 (+65)",
    "馬來西亞 (+60)",
    "美國 (+1)",
];

interface Props {
    contact: ContactDetails;
    disabled: boolean;
    attached?: boolean;
    onChange: (contact: ContactDetails) => void;
    onSave: () => void;
}

export function ContactDetailsPage({ contact, disabled, attached = false, onChange, onSave }: Props) {
    const options = regions.includes(contact.regionLabel) ? regions : [...regions, contact.regionLabel];
    return (
        <div data-tailwind className={`${attached ? stepPanel : panel} space-y-5`}>
            <h2 className="text-xl font-semibold">聯絡資料</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className={fieldLabel}>
                    姓氏
                    <input
                        className={fieldInput}
                        id="lastName"
                        autoComplete="family-name"
                        required
                        disabled={disabled}
                        value={contact.lastName}
                        onChange={e => onChange({ ...contact, lastName: e.target.value })}
                    />
                </label>
                <label className={fieldLabel}>
                    名字
                    <input
                        className={fieldInput}
                        id="firstName"
                        autoComplete="given-name"
                        required
                        disabled={disabled}
                        value={contact.firstName}
                        onChange={e => onChange({ ...contact, firstName: e.target.value })}
                    />
                </label>
                <label className={fieldLabel}>
                    電話區碼
                    <select
                        className={fieldInput}
                        id="regionLabel"
                        disabled={disabled}
                        value={contact.regionLabel}
                        onChange={e => onChange({ ...contact, regionLabel: e.target.value })}
                    >
                        {options.map(region => (
                            <option key={region}>{region}</option>
                        ))}
                    </select>
                </label>
                <label className={fieldLabel}>
                    電話
                    <input
                        className={fieldInput}
                        id="phone"
                        type="tel"
                        autoComplete="tel-national"
                        required
                        disabled={disabled}
                        value={contact.phone}
                        onChange={e => onChange({ ...contact, phone: e.target.value })}
                    />
                </label>
                <label className={fieldLabel}>
                    Email
                    <input
                        className={fieldInput}
                        id="email"
                        type="email"
                        autoComplete="email"
                        required
                        disabled={disabled}
                        value={contact.email}
                        onChange={e => onChange({ ...contact, email: e.target.value })}
                    />
                </label>
            </div>
            <footer className="flex justify-end">
                <button type="button" className={primaryButton} id="saveContact" disabled={disabled} onClick={onSave}>
                    下一步
                </button>
            </footer>
        </div>
    );
}
