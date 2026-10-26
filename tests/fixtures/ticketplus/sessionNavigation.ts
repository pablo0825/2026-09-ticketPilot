import { activity, session } from "./pages.js";

// 目的地由頁面固定指定，不能根據正式程式傳入的設定產生正確答案。
const target = session.replace('<button type="button">', '<button type="button" data-fixture-session="session-B">');
const other = session
    .replace("2026孿生姐妹之夜之鬼迷心竅", "另一個不應選擇的場次")
    .replace('<button type="button">', '<button type="button" data-fixture-session="session-A">');
export const applicationActivity = activity.replace(session, other + target);

// worker 與 fixture 驗證共用真正的導頁事件；不在測試裡另寫一套。
export function installFixtureSessionNavigation(): void {
    document.addEventListener("click", async event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button[data-fixture-session]");
        if (!button) return;
        const sessionId = button.dataset.fixtureSession;
        if (!sessionId) throw new Error("Fixture 場次缺少固定目的地");
        await (window as unknown as { recordFixture: (kind: string) => Promise<void> }).recordFixture("session");
        location.assign("/order/event-fixture/" + sessionId);
    });
}
