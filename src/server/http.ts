import type { IncomingMessage, ServerResponse } from "node:http";

// 一個 API 請求的資料，由各路由共用。
export interface ApiRequest {
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    // 只在啟動購票、格式檢查通過後設定；錯誤處理時才呼叫，判斷這次請求是否尚未被接受。
    notAccepted?: () => boolean;
}

export function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    // 讀取請求內容，限制大小
    const chunks: Buffer[] = [];
    let bytes = 0;

    for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 64 * 1024) throw new Error("設定內容過大。");

        chunks.push(chunk);
    }

    // 轉成 JSON 物件
    try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();

        return value as Record<string, unknown>;
    } catch {
        throw new Error("請提供有效的 JSON 物件。");
    }
}
