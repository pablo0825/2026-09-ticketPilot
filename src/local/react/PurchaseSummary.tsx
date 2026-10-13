import type { ReactNode } from "react";
import type { ActivityDraft } from "./formModel.js";

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="summary-field">
            <span className="summary-label">{label}｜</span>
            <span>{children || "未填寫"}</span>
        </div>
    );
}

function safeEventLink(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname === "www.klook.com" &&
            /^\/zh-TW\/event-detail\/[^/]+\/$/.test(url.pathname) &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
}

export function PurchaseSummary({ draft }: { draft: ActivityDraft }) {
    return (
        <>
            <Field label="活動名稱">{draft.eventName}</Field>
            <Field label="活動網址">
                {safeEventLink(draft.eventUrl) ? (
                    <a href={draft.eventUrl} title={draft.eventUrl} target="_blank" rel="noopener noreferrer">
                        {draft.eventUrl}
                    </a>
                ) : (
                    draft.eventUrl
                )}
            </Field>
            <Field label="排隊流程">{draft.queueEnabled ? "已啟用（最多等待一小時）" : "未啟用"}</Field>
            {draft.bundleEnabled && <Field label="組合套票">已啟用</Field>}
            {draft.deliveryMethod && <Field label="取票方式">{draft.deliveryMethod}</Field>}
            <h3>購票順位</h3>
            <div className="summary-table-scroll" tabIndex={0} role="region" aria-label="購票順位">
                <table>
                    <thead>
                        <tr>
                            {[
                                "順位",
                                "演出日期",
                                "時間",
                                "票區／票種",
                                "張數",
                                "要求連位",
                                ...(draft.bundleEnabled ? ["組合套票"] : []),
                            ].map(title => (
                                <th key={title} scope="col">
                                    {title}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {draft.targets.map((target, index) => (
                            <tr key={index}>
                                <td>{index + 1}</td>
                                <td>{target.date || "未填寫"}</td>
                                <td>{target.time || "未填寫"}</td>
                                <td>{target.area.trim() || "未填寫"}</td>
                                <td>
                                    {Number.isSafeInteger(target.quantity) && target.quantity > 0
                                        ? target.quantity
                                        : "未填寫或無效"}
                                </td>
                                <td>{target.quantity === 1 ? "不適用（單張）" : target.adjacent ? "是" : "否"}</td>
                                {draft.bundleEnabled && <td>{target.bundle?.trim() || "未填寫"}</td>}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Field label="購買規則">依順位嘗試，只購買其中一個符合條件的目標</Field>
            <Field label="排除關鍵字">{draft.excludeKeywords.join("、") || "無"}</Field>
        </>
    );
}
