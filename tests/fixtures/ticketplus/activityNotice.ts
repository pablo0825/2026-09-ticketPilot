// 依 2026-10-17 實站觀察的活動頁提醒彈窗結構（Vuetify persistent dialog）。
export const noticeTitles = {
    lottery: "實名抽選制售票提醒",
    entry: "入場規定",
} as const;

const bodies: Record<string, string> = {
    [noticeTitles.lottery]:
        "登記訂單成立後2小時內恕不受理任何取消申請。 2小時後，於登記期間內，可至「我的訂單」頁面申請取消。",
    [noticeTitles.entry]: "參與本活動需年滿18歲，入場將會查驗證件核對。",
};

export function noticeDialog(title: string, buttons: string[] = ["回到首頁", "確定"]): string {
    const body = bodies[title] ?? "請詳閱本活動說明。";
    const actions = buttons
        .map(label =>
            label === "確定"
                ? `<button type="button" class="v-btn v-btn--block primary" data-notice="ok">${label}</button>`
                : `<button type="button" class="v-btn v-btn--block v-btn--outlined" data-notice="back">${label}</button>`,
        )
        .join("");
    return `<div class="v-dialog__content v-dialog__content--active" role="dialog">
    <div class="v-dialog v-dialog--active v-dialog--persistent">
        <div class="v-card">
            <div class="v-card__title">${title}</div>
            <div class="v-card__text">${body}</div>
            <div class="v-card__actions">${actions}</div>
        </div>
    </div>
</div>`;
}

export type NoticeMode = "dismiss" | "reappear" | "reappear-late" | "stuck";

// 計數兩顆按鈕；「確定」依模式移除、移除後重現或不移除彈窗，「回到首頁」只計數。
export function noticeBehavior(mode: NoticeMode = "dismiss"): string {
    return `<script>
    window.__noticeClicks = { ok: 0, back: 0 };
    document.addEventListener("click", event => {
        const button = event.target.closest("[data-notice]");
        if (!button) return;
        const kind = button.dataset.notice;
        window.__noticeClicks[kind] += 1;
        if (kind !== "ok" || ${JSON.stringify(mode)} === "stuck") return;
        const dialog = button.closest(".v-dialog__content");
        const html = dialog.outerHTML;
        dialog.remove();
        // reappear 在確認期間內重現；reappear-late 在確認期間過後才重現（同一次載入）
        const delay = { reappear: 100, "reappear-late": 700 }[${JSON.stringify(mode)}];
        if (delay) setTimeout(() => document.body.insertAdjacentHTML("beforeend", html), delay);
    });
</script>`;
}

// 延遲出現：模擬選場次等待中才跳出的提醒。
export function delayedNotice(title: string, delayMs: number): string {
    return `<script>
    setTimeout(() => document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(noticeDialog(title))}), ${delayMs});
</script>`;
}
