// 寫入執行紀錄資料夾的舊紀錄；platform 省略時模擬缺少平台欄位的舊檔。
export function historicalRecord(requestId: string, platform?: string, status = "unknown") {
    return {
        fingerprintVersion: 4,
        fingerprint: "a".repeat(64),
        snapshot: {
            ...(platform === undefined ? {} : { platform }),
            id: `1-${requestId}`,
            requestId,
            activityName: "舊活動",
            status,
            browserOpen: false,
            occupied: false,
            message: "提交結果不明",
            historyTruncated: false,
            events: [{ sequence: 1, at: "2026-10-01T00:00:00.000Z", event: { type: "log", message: "舊紀錄" } }],
        },
    };
}
