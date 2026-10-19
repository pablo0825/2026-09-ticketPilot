import { useCallback, useEffect, useRef, useState } from "react";
import type { PurchaseSnapshot } from "../../../purchaseRuns.js";
import type { SimulationSnapshot } from "../../../simulationRuns.js";
import { api, localToken } from "../api.js";
import type { StopRequestStatus } from "./runPresentation.js";

export type DisplayedRun =
    { kind: "purchase"; run: PurchaseSnapshot } | { kind: "simulation"; run: SimulationSnapshot };

function isRunningTicketPlus(run: PurchaseSnapshot): boolean {
    return run.platform === "ticketplus" && run.status === "running";
}

// 只更新正在顯示的同一輪，不切換到其他流程。
function replaceIfDisplayed(previous: DisplayedRun | null, next: DisplayedRun): DisplayedRun | null {
    return previous?.kind === next.kind && previous.run.id === next.run.id ? next : previous;
}

export function useRunStatus(showMessage: (message: string) => void) {
    const [purchase, setPurchase] = useState<PurchaseSnapshot | null>(null);
    const [simulation, setSimulation] = useState<SimulationSnapshot | null>(null);
    const [displayed, setDisplayed] = useState<DisplayedRun | null>(null);
    const [ready, setReady] = useState(false);
    const [closing, setClosing] = useState(false);
    const latestPurchase = useRef<PurchaseSnapshot | null>(null);
    const closingRef = useRef(false);
    const purchaseVersion = useRef(0);
    const attemptedStops = useRef(new Set<string>());
    // 參加者確認依確認 ID 鎖定：同頁連點、回應遺失都不重送。
    const attemptedParticipants = useRef(new Set<string>());
    const [participantsSending, setParticipantsSending] = useState(false);
    const [stopAttempt, setStopAttempt] = useState<{ runId: string; status: StopRequestStatus } | null>(null);

    const receivePurchase = useCallback((run: PurchaseSnapshot | null) => {
        purchaseVersion.current++;
        latestPurchase.current = run;
        setPurchase(run);
        if (run) {
            setDisplayed(previous => replaceIfDisplayed(previous, { kind: "purchase", run }));
        }
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
            stream.onerror = () => active && showMessage("狀態連線中斷，正在重新連線；不會重新開始購票。");
            streams.push(stream);
        };
        subscribe<PurchaseSnapshot | null>("/api/purchase/events", run => {
            receivePurchase(run);
            setReady(true);
        });
        subscribe("/api/events", (run: SimulationSnapshot | null) => {
            setSimulation(run);
            if (run) {
                setDisplayed(previous => replaceIfDisplayed(previous, { kind: "simulation", run }));
            }
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
            error => active && showMessage(error.message),
        );

        return () => {
            active = false;
            streams.forEach(stream => stream.close());
        };
    }, [showMessage, receivePurchase]);

    function isDisplayedPurchase(run: PurchaseSnapshot): boolean {
        return displayed?.kind === "purchase" && displayed.run.id === run.id;
    }

    async function closeBrowser() {
        // 只允許關閉目前顯示且仍受服務管理的購票瀏覽器
        const run = latestPurchase.current;
        if (!run || !isDisplayedPurchase(run)) {
            return;
        }

        // 已在關閉或後端不允許時，不送出要求。
        if (closingRef.current || !run.canCloseBrowser) {
            return;
        }
        const prompt =
            run.status === "payment-ready"
                ? "關閉購票瀏覽器後將離開付款頁。請確認已完成付款，或確定不再付款，再關閉。"
                : "關閉購票瀏覽器？請先確認已檢查頁面及訂單狀態。";
        if (!window.confirm(prompt)) return;

        // 防止重複送出，回應也不能覆蓋另一輪執行
        closingRef.current = true;
        setClosing(true);
        showMessage("");
        try {
            const result = await api<PurchaseSnapshot>("/api/purchase/close-browser", "POST", { runId: run.id });
            if (latestPurchase.current?.id === run.id) receivePurchase(result);
        } catch (error) {
            showMessage((error as Error).message);
        } finally {
            closingRef.current = false;
            setClosing(false);
        }
    }

    async function stopPurchase() {
        // 先請使用者確認；確認期間流程可能已結束，所以確認後才讀取並檢查目前這一輪。
        const confirmed = window.confirm(
            "確定要停止購票嗎？停止後不會自動重新開始；若已送出選票，請到購票瀏覽器確認訂單狀態。",
        );
        if (!confirmed) return;

        // 只操作畫面上正在執行的 TicketPlus 這一輪。
        const run = latestPurchase.current;
        if (!run || !isRunningTicketPlus(run) || !isDisplayedPurchase(run)) {
            return;
        }

        // 後端不允許、已要求停止或正在關閉時，不再送出。
        if (!run.canStop || run.stopRequest || attemptedStops.current.has(run.id) || closingRef.current) {
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

    async function confirmParticipants() {
        // 只操作畫面上正在執行的 TicketPlus 這一輪。
        const run = latestPurchase.current;
        if (!run || !isRunningTicketPlus(run) || !isDisplayedPurchase(run)) {
            return;
        }

        // 後端未提供確認 ID 或已送出時，不再確認。
        const confirmationId = run.participantConfirmation?.confirmationId;
        if (!confirmationId || attemptedParticipants.current.has(confirmationId)) {
            return;
        }

        // ref 立即擋住重送，state 讓畫面更新按鈕狀態；錯誤也不解鎖。
        attemptedParticipants.current.add(confirmationId);
        setParticipantsSending(true);
        const version = purchaseVersion.current;
        try {
            const result = await api<{ run: PurchaseSnapshot }>("/api/purchase/confirm-participants", "POST", {
                runId: run.id,
                confirmationId,
            });
            // 確認回應晚於即時快照時，保留已收到的新狀態。
            if (
                result?.run?.id === run.id &&
                latestPurchase.current?.id === run.id &&
                purchaseVersion.current === version
            ) {
                receivePurchase(result.run);
            }
        } catch (error) {
            showMessage((error as Error).message);
        } finally {
            setParticipantsSending(false);
        }
    }

    const currentDisplayed = purchase !== null && isDisplayedPurchase(purchase);
    const pendingParticipants = purchase?.participantConfirmation?.confirmationId;
    const participantsControl =
        currentDisplayed &&
        purchase &&
        isRunningTicketPlus(purchase) &&
        pendingParticipants &&
        !attemptedParticipants.current.has(pendingParticipants) &&
        !participantsSending
            ? { onConfirm: () => void confirmParticipants() }
            : undefined;
    const stopRequested = Boolean(purchase && (purchase.stopRequest || attemptedStops.current.has(purchase.id)));
    const stopControl =
        currentDisplayed && purchase && isRunningTicketPlus(purchase)
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
        participantsControl,
        showCurrent,
        showResult,
        showAccepted,
        resetDisplay: () => setDisplayed(null),
    };
}
