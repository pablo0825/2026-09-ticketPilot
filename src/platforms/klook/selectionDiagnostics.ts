import { isEventPage } from "./eventPage.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

// 只保存結構與已知購票用語，不保存任意文字、屬性、輸入值或 URL。
export async function captureSelectionDiagnostics(
    page: Page,
    eventUrl: string,
    directory: string,
    label: "failure" | "returned",
): Promise<void> {
    // 只在原活動頁採集
    if (!isEventPage(page.url(), eventUrl)) {
        throw new Error("不在原活動頁，略過選票診斷。");
    }

    // 讀取頁面上的提示與選票區結構
    const snapshot = await page.evaluate(() => {
        const phrases = [
            "已經沒有票了",
            "選位失敗，請重試",
            "未於時限內確認，票券預留失敗",
            "抱歉，時間到了！",
            "請返回並重新排隊",
        ];
        const buttonNames = ["OK", "確認", "確定", "下一步", "重新整理"];

        const roots = Array.from(
            document.querySelectorAll('.klk-modal-alert, [role="dialog"], dialog, #ticket-options'),
        )
            .filter(el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden")
            .slice(0, 10);

        return roots.map(root => ({
            kind: root.id === "ticket-options" ? "tickets" : "dialog",
            // 未知文字只保留是否存在，不輸出內容。
            knownMessages: phrases.filter(text => (root as HTMLElement).innerText.includes(text)),
            hasText: Boolean((root as HTMLElement).innerText.trim()),
            structure: Array.from(root.querySelectorAll("div, p, span, button, input, select"))
                .slice(0, 100)
                .map(el => ({
                    tag: el.tagName.toLowerCase(),
                    visible: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
                    button:
                        el.tagName === "BUTTON" && buttonNames.includes(el.textContent?.trim() ?? "")
                            ? el.textContent!.trim()
                            : undefined,
                })),
        }));
    });

    // 寫入只有自己能讀的檔案
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(
        join(directory, `${label}.json`),
        JSON.stringify(
            {
                capturedAt: new Date().toISOString(),
                containers: snapshot,
                limitation: "僅白名單文字與結構；未知文案及視覺內容請人工補充，不代表已辨識失敗。",
            },
            null,
            4,
        ),
        { mode: 0o600 },
    );
}
