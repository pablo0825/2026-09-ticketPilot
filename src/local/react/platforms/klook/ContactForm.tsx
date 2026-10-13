import type { ContactDetails } from "../../../../config/contact.config.js";

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
    onChange: (contact: ContactDetails) => void;
    onSave: () => void;
}

export function ContactForm({ contact, disabled, onChange, onSave }: Props) {
    const options = regions.includes(contact.regionLabel) ? regions : [...regions, contact.regionLabel];
    return (
        <div className="card">
            <h2>聯絡資料</h2>
            <p>與其他活動共用，儲存在本機；執行紀錄不包含個人資料。</p>
            <div className="grid">
                <label>
                    姓氏
                    <input
                        id="lastName"
                        autoComplete="family-name"
                        required
                        disabled={disabled}
                        value={contact.lastName}
                        onChange={e => onChange({ ...contact, lastName: e.target.value })}
                    />
                </label>
                <label>
                    名字
                    <input
                        id="firstName"
                        autoComplete="given-name"
                        required
                        disabled={disabled}
                        value={contact.firstName}
                        onChange={e => onChange({ ...contact, firstName: e.target.value })}
                    />
                </label>
                <label>
                    電話區碼
                    <select
                        id="regionLabel"
                        disabled={disabled}
                        value={contact.regionLabel}
                        onChange={e => onChange({ ...contact, regionLabel: e.target.value })}
                    >
                        {options.map(region => (
                            <option key={region}>{region}</option>
                        ))}
                    </select>
                    <small>網站若沒有對應選項，程式會停止。</small>
                </label>
                <label>
                    電話
                    <input
                        id="phone"
                        type="tel"
                        autoComplete="tel-national"
                        required
                        disabled={disabled}
                        value={contact.phone}
                        onChange={e => onChange({ ...contact, phone: e.target.value })}
                    />
                </label>
                <label>
                    Email
                    <input
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
            <footer>
                <button id="saveContact" disabled={disabled} onClick={onSave}>
                    下一步
                </button>
            </footer>
        </div>
    );
}
