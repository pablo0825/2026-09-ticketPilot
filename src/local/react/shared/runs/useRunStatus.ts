import { useCallback, useEffect, useRef, useState } from "react";
import type { PurchaseSnapshot } from "../../../purchaseRuns.js";
import type { SimulationSnapshot } from "../../../simulationRuns.js";
import { api, localToken } from "../api.js";
import type { StopRequestStatus } from "./runPresentation.js";

export type DisplayedRun =
    { kind: "purchase"; run: PurchaseSnapshot } | { kind: "simulation"; run: SimulationSnapshot };

export function useRunStatus(onError: (message: string) => void) {
    const [purchase, setPurchase] = useState<PurchaseSnapshot | null>(null);
    const [simulation, setSimulation] = useState<SimulationSnapshot | null>(null);
    const [displayed, setDisplayed] = useState<DisplayedRun | null>(null);
    const [ready, setReady] = useState(false);
    const [closing, setClosing] = useState(false);
    const latestPurchase = useRef<PurchaseSnapshot | null>(null);
    const closingRef = useRef(false);
    const purchaseVersion = useRef(0);
    const attemptedStops = useRef(new Set<string>());
    const [stopAttempt, setStopAttempt] = useState<{ runId: string; status: StopRequestStatus } | null>(null);

    const receivePurchase = useCallback((run: PurchaseSnapshot | null) => {
        purchaseVersion.current++;
        latestPurchase.current = run;
        setPurchase(run);
        if (run)
            setDisplayed(previous =>
                previous?.kind === "purchase" && previous.run.id === run.id ? { kind: "purchase", run } : previous,
            );
    }, []);

    useEffect(() => {
        // 建立狀態訂閱；每次掛載都有對應清理，重連不啟動購票
        let active = true;
        const streams: EventSource[] = [];
        const subscribe = <T>(path: string, receive: (run: T) => void) => {
            const stream = new EventSource(path + "?token=" + encodeURIComponent(localToken()));
            stream.onmessage = event => {
                if (active) receive(JSON.parse(event.data));
            };
            stream.onerror = () => active && onError("狀態連線中斷，正在重新連線；不會重新開始購票。");
            streams.push(stream);
        };
        subscribe<PurchaseSnapshot | null>("/api/purchase/events", run => {
            receivePurchase(run);
            setReady(true);
        });
        subscribe("/api/events", (run: SimulationSnapshot | null) => {
            setSimulation(run);
            if (run)
                setDisplayed(previous =>
                    previous?.kind === "simulation" && previous.run.id === run.id
                        ? { kind: "simulation", run }
                        : previous,
                );
        });

        // 初始讀取不能覆蓋較晚收到的 SSE 快照
        const version = purchaseVersion.current;
        void api<PurchaseSnapshot | null>("/api/purchase").then(
            run => {
                if (active && purchaseVersion.current === version) {
                    receivePurchase(run);
                    setReady(true);
                }
            },
            error => active && onError(error.message),
        );

        return () => {
            active = false;
            streams.forEach(stream => stream.close());
        };
    }, [onError, receivePurchase]);

    async function closeBrowser() {
        // 只允許關閉目前顯示且仍受服務管理的購票瀏覽器
        const run = latestPurchase.current;
        if (
            closingRef.current ||
            !run?.canCloseBrowser ||
            displayed?.kind !== "purchase" ||
            displayed.run.id !== run.id
        )
            return;
        const prompt =
            run.status === "payment-ready"
                ? "關閉購票瀏覽器後將離開付款頁。請確認已完成付款，或確定不再付款，再關閉。"
                : "關閉購票瀏覽器？請先確認已檢查頁面及訂單狀態。";
        if (!window.confirm(prompt)) return;

        // 防止重複送出，回應也不能覆蓋另一輪執行
        closingRef.current = true;
        setClosing(true);
        onError("");
        try {
            const result = await api<PurchaseSnapshot>("/api/purchase/close-browser", "POST", { runId: run.id });
            if (latestPurchase.current?.id === run.id) receivePurchase(result);
        } catch (error) {
            onError((error as Error).message);
        } finally {
            closingRef.current = false;
            setClosing(false);
        }
    }

    async function stopPurchase() {
        // 只停止目前顯示且由後端允許控制的這一輪。
        const run = latestPurchase.current;
        if (
            !run ||
            run.platform !== "ticketplus" ||
            run.status !== "running" ||
            !run.canStop ||
            run.stopRequest ||
            attemptedStops.current.has(run.id) ||
            closingRef.current ||
            displayed?.kind !== "purchase" ||
            displayed.run.id !== run.id
        ) {
            return;
        }

        // 送出前同步鎖定本輪，避免重複停止要求。
        attemptedStops.current.add(run.id);
        setStopAttempt({ runId: run.id, status: "sending" });
        const version = purchaseVersion.current;
        try {
            const result = await api<{ status: StopRequestStatus; run: PurchaseSnapshot }>(
                "/api/purchase/stop",
                "POST",
                { runId: run.id },
            );
            if (
                !result ||
                !["sending", "sent", "unconfirmed"].includes(result.status) ||
                result.run?.id !== run.id ||
                result.run.platform !== "ticketplus"
            ) {
                throw new Error("無法核對停止回應。");
            }
            if (latestPurchase.current?.id !== run.id) return;
            if (purchaseVersion.current === version) receivePurchase(result.run);
            if (latestPurchase.current?.status === "running") {
                setStopAttempt({ runId: run.id, status: result.status });
            }
        } catch {
            // 結果不明仍保留本頁停止鎖；終局與後端即時要求始終優先。
            if (latestPurchase.current?.id === run.id && latestPurchase.current.status === "running") {
                setStopAttempt({ runId: run.id, status: "unconfirmed" });
            }
        }
    }

    const currentDisplayed = displayed?.kind === "purchase" && displayed.run.id === purchase?.id;
    const stopRequested = Boolean(purchase && (purchase.stopRequest || attemptedStops.current.has(purchase.id)));
    const stopControl =
        currentDisplayed && purchase?.platform === "ticketplus" && purchase.status === "running"
            ? {
                  available: !closing && purchase.canStop === true && !stopRequested,
                  progress:
                      purchase.stopRequest?.status ??
                      (stopAttempt?.runId === purchase.id ? stopAttempt.status : undefined),
                  onStop: () => void stopPurchase(),
              }
            : undefined;

    function showCurrent() {
        if (purchase?.occupied) setDisplayed({ kind: "purchase", run: purchase });
        else if (simulation?.status === "running") setDisplayed({ kind: "simulation", run: simulation });
        else if (purchase) setDisplayed({ kind: "purchase", run: purchase });
    }

    function showResult(kind: "purchase" | "simulation") {
        if (kind === "purchase" && purchase) setDisplayed({ kind, run: purchase });
        if (kind === "simulation" && simulation) setDisplayed({ kind, run: simulation });
    }

    function showAccepted(run: PurchaseSnapshot, previousId: string | undefined) {
        // POST 可能比同一輪的 SSE 晚到，保留已收到的最新狀態
        const latest = latestPurchase.current;
        const snapshot = latest?.id === run.id ? latest : run;
        if (!latest || latest.id === run.id || latest.id === previousId) receivePurchase(snapshot);
        setDisplayed({ kind: "purchase", run: snapshot });
    }

    return {
        purchase,
        simulation,
        displayed,
        ready,
        closing,
        closeBrowser,
        stopControl,
        showCurrent,
        showResult,
        showAccepted,
        resetDisplay: () => setDisplayed(null),
    };
}
