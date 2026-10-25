// worker 端的參加者確認閘門：只接受目前等待中、ID 相同、格式完全相符的確認一次；
// 提早、錯誤、重複或多餘欄位的訊息一律忽略，不保留給之後的等待。
export function createParticipantGate(messageType = "confirm-ticketplus-participants") {
    let pending: { confirmationId: string; resolve: () => void } | undefined;

    return {
        wait(confirmationId: string): Promise<void> {
            return new Promise(resolve => {
                pending = { confirmationId, resolve };
            });
        },
        receive(message: unknown): boolean {
            if (!pending) return false;

            if (!message || typeof message !== "object") return false;

            if (Object.keys(message).length !== 2) return false;

            if (!("type" in message) || message.type !== messageType) return false;

            if (!("confirmationId" in message) || message.confirmationId !== pending.confirmationId) {
                return false;
            }

            const { resolve } = pending;
            pending = undefined;
            resolve();
            return true;
        },
    };
}
