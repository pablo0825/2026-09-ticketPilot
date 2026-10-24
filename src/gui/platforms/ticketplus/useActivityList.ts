import { useCallback, useEffect, useRef, useState } from "react";
import type { ActivityExecutionStatus } from "../../../shared/activityExecutionStatus.js";
import type { ActivityRecord } from "../../../shared/activityRecord.js";
import { api } from "../../shared/api.js";
import { ticketPlusRecord, type TicketPlusActivityRecord } from "./formModel.js";

export type ActivityListEntry = TicketPlusActivityRecord & { executionStatus: ActivityExecutionStatus | "待重新載入" };

interface ActivityListData {
    activities: (ActivityRecord & { executionStatus: ActivityExecutionStatus })[];
    invalidFiles: number;
}

// 載入 TicketPlus 活動列表；執行狀態改變時重新載入，晚到的回應不覆蓋較新的結果。
// setMessage 必須是穩定的函式，否則每次重繪都會重新載入列表。
export function useActivityList(statusKey: string, setMessage: (message: string) => void) {
    const [activities, setActivities] = useState<ActivityListEntry[]>([]);
    const [initialized, setInitialized] = useState(false);
    const [listLoading, setListLoading] = useState(true);
    const [listError, setListError] = useState("");
    const listLoadingRef = useRef(false);
    const mounted = useRef(true);
    const listRequest = useRef(0);

    // 目前請求成功時回傳無效設定檔數；請求已過期或元件已卸載時回傳 undefined。
    // 只有目前請求失敗才丟出錯誤，讓呼叫端決定要不要另外提示。
    const refreshList = useCallback(async (): Promise<number | undefined> => {
        const request = ++listRequest.current;
        listLoadingRef.current = true;
        setListLoading(true);
        try {
            const data = await api<ActivityListData>("/api/activities");
            if (!mounted.current || request !== listRequest.current) return;
            const items = data.activities
                .filter(item => item.settings.platform === "ticketplus")
                .map(item => ({
                    ...ticketPlusRecord(item),
                    executionStatus: item.executionStatus,
                }));
            setActivities(items);
            setInitialized(true);
            setListError("");
            if (data.invalidFiles) setMessage(`${data.invalidFiles} 個設定檔無法載入，未覆寫。`);
            return data.invalidFiles;
        } catch (error) {
            if (!mounted.current || request !== listRequest.current) return;
            // 保留上次讀到的列表，錯誤不與購票狀態訊息共用。
            setListError(error instanceof Error ? error.message : String(error));
            throw error;
        } finally {
            if (mounted.current && request === listRequest.current) {
                listLoadingRef.current = false;
                setListLoading(false);
            }
        }
    }, [setMessage]);

    // 不會丟出錯誤；失敗只顯示在列表區塊。
    const loadListForDisplay = useCallback(async () => {
        try {
            await refreshList();
        } catch {
            // refreshList 已在列表顯示錯誤；不要覆蓋全域執行訊息。
        }
    }, [refreshList]);

    // 掛載狀態在 effect 內設定，StrictMode 模擬卸載後重新掛載時才會設回 true。
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            listRequest.current++;
        };
    }, []);
    // 執行狀態改變時取消進行中的載入並重新載入，包含儲存或刪除後發出的載入。
    useEffect(() => {
        void loadListForDisplay();
        return () => {
            listRequest.current++;
        };
    }, [loadListForDisplay, statusKey]);

    return {
        activities,
        updateActivities: setActivities,
        initialized,
        listLoading,
        listError,
        // 讀取當下的載入狀態，不等待重繪；用於防止連點重送。
        isListLoading: () => listLoadingRef.current,
        refreshList,
        loadListForDisplay,
    };
}
