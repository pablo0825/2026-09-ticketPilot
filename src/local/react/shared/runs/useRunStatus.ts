import { useCallback, useEffect, useRef, useState } from "react";
import type { PurchaseSnapshot } from "../../../purchaseRuns.js";
import type { SimulationSnapshot } from "../../../simulationRuns.js";
import { api, localToken } from "../api.js";

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
    const attemptedLogins = useRef(new Set<string>());
    const [loginAttempt, setLoginAttempt] = useState<{ runId: string; message: string } | null>(null);

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

    async function confirmLogin() {
        // 只交接目前顯示且仍持有即時資格的 TicketPlus 流程。
        const run = latestPurchase.current;
        const confirmationId = run?.loginConfirmation?.confirmationId;
        if (
            !run ||
            run.platform !== "ticketplus" ||
            run.status !== "running" ||
            !confirmationId ||
            closingRef.current ||
            displayed?.kind !== "purchase" ||
            displayed.run.id !== run.id
        )
            return;
        const key = `${run.id}:${confirmationId}`;
        if (attemptedLogins.current.has(key)) return;

        // 先消耗本頁的確認資格，失敗或斷線也不能自動重送同一資格。
        attemptedLogins.current.add(key);
        setLoginAttempt({ runId: run.id, message: "正在送出登入確認，請稍候。" });
        const version = purchaseVersion.current;
        try {
            const result = await api<{ status: "sent"; message: string; run: PurchaseSnapshot }>(
                "/api/purchase/confirm-login",
                "POST",
                { runId: run.id, confirmationId },
            );
            if (result.status !== "sent" || result.run.id !== run.id || result.run.platform !== "ticketplus") {
                throw new Error("登入確認回應無法核對。");
            }
            if (latestPurchase.current?.id !== run.id) return;
            if (purchaseVersion.current === version) receivePurchase(result.run);
            setLoginAttempt({ runId: run.id, message: "已送出登入確認，請查看後續狀態；尚不代表登入或購票成功。" });
        } catch {
            if (latestPurchase.current?.id === run.id) {
                setLoginAttempt({
                    runId: run.id,
                    message: "登入確認結果尚未確認，請查看後續狀態與購票瀏覽器；不會自動重送。",
                });
            }
        }
    }

    const currentDisplayed = displayed?.kind === "purchase" && displayed.run.id === purchase?.id;
    const loginStage = purchase?.events.filter(item => item.event.type === "ticketplus").at(-1)?.event;
    const waitingForLogin =
        loginStage?.type === "ticketplus" && ["login-ready", "waiting-for-login"].includes(loginStage.stage);
    const loginKey = `${purchase?.id}:${purchase?.loginConfirmation?.confirmationId}`;
    const loginHandoff =
        currentDisplayed && purchase?.platform === "ticketplus" && purchase.status === "running"
            ? {
                  available: !closing && Boolean(purchase.loginConfirmation) && !attemptedLogins.current.has(loginKey),
                  message: waitingForLogin && loginAttempt?.runId === purchase.id ? loginAttempt.message : "",
                  onConfirm: () => void confirmLogin(),
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
        loginHandoff,
        showCurrent,
        showResult,
        showAccepted,
        resetDisplay: () => setDisplayed(null),
    };
}
