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

// full：舊樣本，空窗移除計數器；live：2026-10-17 實站樣本，空窗保留計數器，售完列暫時多出計數器。
// keep-status／keep-sold-out：live 但分別留下庫存或已售完文字，屬於不完整的空窗。
export type RefreshExampleMode = "full" | "live" | "keep-status" | "keep-sold-out" | "button-only";

export async function installRefreshExample(page: Page, mode: RefreshExampleMode = "full") {
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
                // 依模式決定空窗時移除哪些動態欄位；keep-* 只拿掉一半，用來確認不完整的空窗不算數。
                const removeStatus = mode === "full" || mode === "live" || mode === "keep-sold-out";
                const removeSoldOut = mode === "full" || mode === "live" || mode === "keep-status";
                const removeCounters = mode === "full";
                const soldOutCounter =
                    '<div class="count-button d-flex"><button type="button" disabled><span><i aria-hidden="true" class="mdi mdi-minus"></i></span></button><div>0</div><button type="button"><span><i aria-hidden="true" class="mdi mdi-plus"></i></span></button></div>';

                for (const { row } of originals) {
                    if (removeStatus) {
                        row.querySelectorAll(".font-weight-medium > span:not(.v-tooltip)").forEach(node =>
                            node.remove(),
                        );
                    }
                    if (removeCounters) row.querySelectorAll(".count-button").forEach(node => node.remove());
                    if (removeSoldOut) {
                        // 實站售完列在空窗時暫時多出一組計數器；舊樣本則直接消失。
                        const soldOut = Array.from(row.querySelectorAll("span")).filter(
                            node => node.textContent?.trim() === "已售完",
                        );
                        for (const node of soldOut) {
                            if (removeCounters) node.remove();
                            else node.outerHTML = soldOutCounter;
                        }
                    }
                }
                window.refreshExample.phase = "partial";
            }, 0);
        });
    }, mode);
}
