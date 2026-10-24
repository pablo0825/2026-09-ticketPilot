export interface ApiError extends Error {
    notAccepted?: boolean;
}

export function localToken(): string {
    const token = document.querySelector<HTMLMetaElement>('meta[name="local-token"]')?.content;
    if (!token || token === "__TOKEN__") throw new Error("本機工作階段無效，請重新開啟介面。");
    return token;
}

export async function api<T>(path: string, method = "GET", value?: unknown, revision?: string): Promise<T> {
    // 送出同源請求，保留本機工作階段與版本核對
    const response = await fetch(path, {
        method,
        headers: {
            "X-Local-Token": localToken(),
            "Content-Type": "application/json",
            ...(revision ? { "X-Activity-Revision": revision } : {}),
        },
        body: value === undefined ? undefined : JSON.stringify(value),
    });

    // 只有後端明確拒絕才能視為未啟動
    const data = await response.json();
    if (!response.ok) {
        const error: ApiError = new Error(data.error);
        error.notAccepted = data.notAccepted === true;
        throw error;
    }
    return data as T;
}
