import { eventHeader } from "./pages.js";

// 依 2026-10-17 實站觀察（LOOKMHEE C 區電腦選位）重建的 /confirmSeat 最小 DOM。
export interface SeatRow {
    area: string;
    position: string;
    ticketType: string;
    price?: string;
}

export const observedSeat: SeatRow = { area: "C 區", position: "25 排 7 號", ticketType: "預售票" };

export function seatRow(row: SeatRow): string {
    return `<div class="row py-2 py-md-3 no-gutters"><div>${row.area}</div><div>${row.position}</div><div>${row.ticketType}</div><div>NT. ${row.price ?? "5,800"}</div></div>`;
}

export function seatConfirmPage(rows: SeatRow[] = [observedSeat], extra = ""): string {
    return `${eventHeader}
<div class="stepText checkedStep">選擇票區</div><div class="stepText currStep">選擇座位</div>
<div>請在 9:51 內完成購票手續並確認訂單</div>
<div class="text-center bg-tranparent-yellow pa-3 text-title font-weight-bold">確認選位結果</div>
<div class="row py-3 font-weight-bold text-nine no-gutters"><div>票區</div><div>位置</div><div>票種</div><div>金額</div></div>
${rows.map(seatRow).join("")}
${extra}
<button type="button" class="v-btn v-btn--outlined" data-seat="cancel">取消購票</button>
<button type="button" class="nextBtn v-btn" data-seat="next">下一步</button>`;
}

export type SeatNextMode = "to-information" | "stay";

// 計數「下一步」與「取消購票」；下一步依模式轉到同場次 confirm 資料頁或停留原頁。
export function seatBehavior(mode: SeatNextMode, informationPath: string): string {
    return `<script>
    document.addEventListener("click", event => {
        const button = event.target.closest("[data-seat]");
        if (!button) return;
        const key = "seat-" + button.dataset.seat;
        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1));
        if (button.dataset.seat === "next" && ${JSON.stringify(mode)} === "to-information") {
            location.assign(${JSON.stringify(informationPath)});
        }
    });
</script>`;
}
