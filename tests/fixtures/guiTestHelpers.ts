import type { Page } from "playwright";

// 每次短串流結束後由原生 EventSource 重連，下一次收到最新快照。
export async function snapshotFeed(page: Page, path: string, initial?: unknown) {
    let snapshot = initial;
    await page.route("**" + path + "?*", route =>
        route.fulfill({
            contentType: "text/event-stream",
            body: "retry: 20\n" + (snapshot === undefined ? "\n" : `data: ${JSON.stringify(snapshot)}\n\n`),
        }),
    );
    return {
        publish(value: unknown) {
            snapshot = value;
        },
    };
}

// 等待可觀察結果，逾時保留最後一次斷言的具體差異。
export async function eventually(assertion: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
        try {
            await assertion();
            return;
        } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
}

// 真正從平台首頁進入工作區，避免測試繞過正式導覽。
export async function enterTicketPlus(page: Page): Promise<void> {
    await page.getByRole("button", { name: "進入 TicketPlus", exact: true }).click();
}
