import type { Page } from "playwright";

declare global {
    interface Window {
        refreshExample: {
            phase: "idle" | "partial" | "data-restored" | "restored";
            enabled: boolean;
            restoreData(): void;
            restoreButton(): void;
        };
    }
}

export async function installRefreshExample(page: Page, mode: "full" | "button-only" = "full") {
    await page.evaluate(mode => {
        // fixture 只依點擊及測試指令改畫面，不讀取正式程式的判定結果。
        const originals = Array.from(document.querySelectorAll<HTMLElement>(".rwd-margin"), row => ({
            row,
            html: row.innerHTML,
        }));
        let buttonHtml = "";
        window.refreshExample = {
            phase: "idle",
            enabled: true,
            restoreData() {
                for (const { row, html } of originals) row.innerHTML = html;
                window.refreshExample.phase = "data-restored";
            },
            restoreButton() {
                document.body.insertAdjacentHTML("beforeend", buttonHtml);
                window.refreshExample.phase = "restored";
            },
        };

        // 移除與恢復使用不同事件階段，按鈕恢復時是全新的節點。
        document.addEventListener("click", event => {
            const button = (event.target as Element).closest("button");
            if (!button || button.textContent?.trim() !== "更新票數" || !window.refreshExample.enabled) return;
            buttonHtml = button.outerHTML;
            button.remove();
            setTimeout(() => {
                if (mode === "full") {
                    for (const { row } of originals) {
                        row.querySelectorAll(".font-weight-medium > span, .count-button").forEach(node =>
                            node.remove(),
                        );
                        row.querySelectorAll("span").forEach(node => {
                            if (node.textContent?.trim() === "已售完") node.remove();
                        });
                    }
                }
                window.refreshExample.phase = "partial";
            }, 0);
        });
    }, mode);
}
