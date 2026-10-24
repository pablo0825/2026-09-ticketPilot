import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { json } from "./http.js";

// 提供網頁與打包的腳本、樣式；回傳 false 表示不是靜態資源，交給 API 處理。
// 呼叫前必須已完成 Host 與 Origin 檢查，因為網頁內含本機 token。
export async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    token: string,
): Promise<boolean> {
    if (request.method === "GET" && url.pathname === "/") {
        if (request.headers["sec-fetch-site"] === "cross-site") {
            json(response, 403, {});
            return true;
        }

        const index = new URL("../../dist/react/index.html", import.meta.url);
        const html = (await readFile(index, "utf8")).replace("__TOKEN__", token);

        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy":
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
            "Referrer-Policy": "no-referrer",
        });
        response.end(html);
        return true;
    }

    // 只提供打包的腳本與樣式，不把檔案系統路徑交給請求決定
    if (request.method === "GET" && /^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(url.pathname)) {
        const asset = new URL(`../../dist/react${url.pathname}`, import.meta.url);
        const content = await readFile(asset);
        response.writeHead(200, {
            "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
            "Cache-Control": "no-store",
        });
        response.end(content);
        return true;
    }

    return false;
}
