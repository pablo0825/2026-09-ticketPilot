import { waitForTicketOptions, pollSelection, selectionWaitTimeout } from "./selectionPolling.js";
import { clickTargetOption, findTargetOption, verifySelectedTarget } from "./selectionOptions.js";
import type { TargetGroup } from "./selectionOptions.js";
import { KlookTicketExtras } from "./ticketExtras.js";
import { PurchaseStop } from "../../core/purchaseStop.js";
import { validateTicketTarget } from "../../core/purchaseValidation.js";
import { KlookSelectionControls } from "./selectionControls.js";
import type { Page } from "playwright";
import type { TicketTarget, TicketOptions } from "../../core/types.js";
import { log } from "../../core/logger.js";

export class KlookTicketSelector {
    constructor(
        private readonly page: Page,
        private readonly timeout = selectionWaitTimeout,
        private readonly observeSelectionNotice: () => Promise<void> = async () => {},
    ) {}

    async selectAndVerify(target: TicketTarget, options: TicketOptions = {}): Promise<"selected" | "disabled"> {
        validateTicketTarget(target);
        await waitForTicketOptions(this.page, this.observeSelectionNotice, this.timeout);

        // 收集完成後依序操作；下游停用前仍核對已選好的上游條件。
        if (!(await this.selectGroup("日期", target.date))) return "disabled";
        if (!(await this.selectGroup("時間", target.time))) {
            await this.verifyGroup("日期", target.date);
            return "disabled";
        }
        if (!(await this.selectGroup("票種", target.area))) {
            await this.verifyGroup("日期", target.date);
            await this.verifyGroup("時間", target.time);
            return "disabled";
        }

        const extras = new KlookTicketExtras(this.page, target, options, this.timeout, this.observeSelectionNotice);
        await extras.select();
        const controls = new KlookSelectionControls(this.page, this.timeout, this.observeSelectionNotice);
        await controls.select(target);

        // 同批替換操作與最終核對，後續操作不得默默重設已選項目。
        await this.verifyGroup("日期", target.date);
        await this.verifyGroup("時間", target.time);
        await this.verifyGroup("票種", target.area);
        await controls.verify(target);
        await extras.verify();
        log("選票驗證完成，目前尚未取得座位。");
        return "selected";
    }

    private async selectGroup(name: TargetGroup, wanted: string): Promise<boolean> {
        const snapshot = await pollSelection(
            this.page,
            data => findTargetOption(data, name, wanted) !== undefined,
            `${name}資料尚未完整`,
            this.observeSelectionNotice,
            this.timeout,
        );
        const option = findTargetOption(snapshot, name, wanted);
        if (!option) throw new PurchaseStop(`${name}資料不完整。`);

        // 日期／時間沿用原停用規則；票種只有明確 disabled 才跳順位。
        if (option.disabled || (name !== "票種" && (option.soldOut || !option.enabled))) {
            if (option.selected || !option.disabled) throw new PurchaseStop(`${name}停用狀態不明或矛盾，已停止。`);
            log(`${name}目前不可選：${wanted}；未送出選票。`);
            return false;
        }
        if (!option.selected) {
            await this.observeSelectionNotice();
            await clickTargetOption(this.page, name, option, this.timeout);
            // 已嘗試點擊就只讀取，不因結果延遲再點一次。
            await pollSelection(
                this.page,
                data => findTargetOption(data, name, wanted)?.selected === true,
                `${name}點選後沒有確認選中`,
                this.observeSelectionNotice,
                this.timeout,
            );
        }
        await this.verifyGroup(name, wanted);
        log(`${name}已選：${wanted}${name === "日期" ? "；完整年份於配位確認前核對。" : ""}`);
        return true;
    }

    private async verifyGroup(name: TargetGroup, wanted: string): Promise<void> {
        await pollSelection(
            this.page,
            snapshot => {
                verifySelectedTarget(snapshot, name, wanted);
                return true;
            },
            `${name}最終資料尚未完整`,
            this.observeSelectionNotice,
            this.timeout,
        );
    }
}
